/* eslint-disable @typescript-eslint/no-unused-vars */
import { CliUx } from '@oclif/core';
import { ReleaseMeta } from "@valist/sdk";
import { SupportedPlatform } from '@valist/sdk/dist/typesShared';
import { zipDirectory } from './zip';
import { ReleaseConfig } from './types';
import { getZipName } from './utils/getZipName';
import { DesktopPlatform, WebPlatform, getSignedUploadUrls, uploadFileS3 } from '@valist/sdk/dist/s3';
import fs from "fs";
import { AxiosInstance } from 'axios';

interface PlatformEntry {
  platform: string
  path: string
  installScript: string
  executable: string
}

const baseGateWayURL = `https://gateway-b3.valist.io`;

export async function uploadRelease(client: AxiosInstance, config: ReleaseConfig) {
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

  const releasePath = `${config.account}/${config.project}/${config.release}`;
  const meta: ReleaseMeta = {
    _metadata_version: "2",
    path: releasePath,
    name: config.release,
    description: config.description || "",
    external_url: `${baseGateWayURL}/${releasePath}`,
    platforms: {},
  };
  CliUx.ux.action.start('uploading files');

  const platformsToSign: Partial<Record<SupportedPlatform, DesktopPlatform | WebPlatform>> = {};
  for (const platformEntry of updatedPlatformEntries) {
    const platformKey = platformEntry.platform as SupportedPlatform;
    const { path, executable } = platformEntry;
    const file = fs.createReadStream(path);

    platformsToSign[platformKey] = {
      platform: platformKey,
      files: file,
      executable,
    };
  }

  CliUx.ux.action.start("Generating presigned urls");
  const urls = await getSignedUploadUrls(
    config.account,
    config.project,
    config.release,
    platformsToSign,
    {
      client,
    },
  );
  CliUx.ux.action.stop();

  const signedPlatformEntries = Object.entries(platformsToSign);
  for (const [name, platform] of signedPlatformEntries) {
    const preSignedUrl = urls.find((data) => data.platformKey === name);
    if (!preSignedUrl) throw "no pre-signed url found for platform";

    const { uploadId, partUrls, key } = preSignedUrl;
    const fileData = platform.files as fs.ReadStream;

    let location: string = '';
    const progressIterator = uploadFileS3(
      fileData,
      uploadId,
      key,
      partUrls,
      {
        client,
      }
    );

    for await (const progressUpdate of progressIterator) {
      if (typeof progressUpdate === 'number') {
        CliUx.ux.log(`Upload progress for ${name}: ${progressUpdate}`);
      } else {
        location = progressUpdate;
      }
    }

    if (location === '') throw ('no location returned');

    const { files, ...rest } = platform as DesktopPlatform;
    const updatedPlatform = updatedPlatformEntries.find((item) => item.platform === name);
    if (!updatedPlatform) throw ("updated platform path not found");

    const fileStat = await fs.promises.stat(updatedPlatform.path);
    const downloadSize = fileStat.size.toString();

    meta.platforms[name as SupportedPlatform] = {
      ...rest,
      name: preSignedUrl.fileName,
      external_url: `${baseGateWayURL}${location}`,
      downloadSize: downloadSize,
      installSize: downloadSize,
      installScript: updatedPlatform.installScript,
    };
  }
  CliUx.ux.action.stop();
  return meta;
}
