/* eslint-disable @typescript-eslint/no-unused-vars */
import { CliUx } from '@oclif/core';
import { Client, ReleaseMeta } from "@valist/sdk";
import { SupportedPlatform } from '@valist/sdk/dist/typesShared';
import { zipDirectory } from './zip';
import { ReleaseConfig } from './types';
import { getZipName } from './utils/getZipName';
import { DesktopPlatform, getSignedUploadUrls, uploadFileS3 } from '@valist/sdk/dist/s3';

interface PlatformEntry {
  platform: string
  path: string
  installScript: string
  executable: string
}

const baseGateWayURL = `https://gateway-b3.valist.io`;

export async function uploadRelease(valist: Client, config: ReleaseConfig) {
  const updatedPlatformEntries: PlatformEntry[] = await Promise.all(Object.entries(config.platforms).map(async ([platform, platformConfig]) => {
    const installScript = platformConfig.installScript;
    const executable = platformConfig.executable;
    if (config && config.platforms[platform] && !config.platforms[platform].zip) {
      return { platform, path: platformConfig.path, installScript, executable }
    }
    const zipPath = getZipName(platformConfig.path);
    CliUx.ux.action.start(`zipping ${zipPath}`);
    await zipDirectory(platformConfig.path, zipPath);
    CliUx.ux.action.stop();
    return { platform, path: zipPath, installScript, executable };
  }));

  const meta: ReleaseMeta = {
    _metadata_version: "2",
    path: `${config.account}/${config.project}/${config.release}`,
    name: config.release,
    description: config.description || "",
    external_url: "",
    platforms: {},
  };
  CliUx.ux.action.start('uploading files');

  CliUx.ux.action.start(`generating presigned urls`);
  const urls = await getSignedUploadUrls(
    config.account,
    config.project,
    config.release,
    {},
  );

  for (const entry of updatedPlatformEntries) {
    const preSignedUrl = urls.find((data) => entry.platform === data.platformKey);
    if (!preSignedUrl) throw "no pre-signed url found for platform";

    const { uploadId, partUrls, key } = preSignedUrl;
    const fileData = (entry as unknown as File[])[0];

    let location: string = '';
    const progressIterator = uploadFileS3(
      fileData,
      entry.platform,
      uploadId,
      key,
      partUrls,
    );

    for await (const progressUpdate of progressIterator) {
      if (typeof progressUpdate === 'number') {
        CliUx.ux.action.start(`Upload progress ${progressUpdate}`);
      } else {
        location = progressUpdate;
      }
    }

    if (location === '') throw ('no location returned');

    const { files: _, ...rest } = entry as unknown as DesktopPlatform;
    const downloadSize = fileData.size.toString();

    meta.platforms[entry.platform as SupportedPlatform] = {
      ...rest,
      name: preSignedUrl.fileName,
      external_url: `${baseGateWayURL}${location}`,
      downloadSize: downloadSize,
      installSize: downloadSize,
    };
    CliUx.ux.action.stop(`Successfully uploaded releases`);
  }
  CliUx.ux.action.stop();
  return meta;
}
