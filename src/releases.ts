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

  for (const platformEntry of updatedPlatformEntries) {
    const platformKey = platformEntry.platform as SupportedPlatform;
    const { path, executable } = platformEntry;

    const files = [{
      fileName: path.split("/").pop() || "file",
      fileType: "application/octet-stream",
      fileSize: (await fs.promises.stat(path)).size,
    }];

    CliUx.ux.action.start(`Generating presigned URLs for ${platformKey}`);
    const urls = await getSignedUploadUrls(
      config.account,
      config.project,
      config.release,
      platformKey,
      files,
      { client },
    );

    CliUx.ux.action.stop();
    const preSignedUrl = urls[0];
    if (!preSignedUrl) throw new Error("No presigned URL found for platform");

    const { uploadId, partUrls, key } = preSignedUrl;
    const fileData = platformEntry.path;

    let location: string = '';
    const progressIterator = uploadFileS3(
      fs.createReadStream(fileData),
      uploadId,
      key,
      partUrls,
      { client }
    );

    // Track upload progress
    for await (const progressUpdate of progressIterator) {
      if (typeof progressUpdate === 'number') {
        CliUx.ux.log(`Upload progress for ${platformKey}: ${progressUpdate}%`);
      } else {
        location = progressUpdate;
      }
    }

    if (!location) throw new Error('No location returned');

    const fileStat = await fs.promises.stat(platformEntry.path);
    const downloadSize = fileStat.size.toString();

    // Add platform metadata after successful upload
    meta.platforms[platformKey] = {
      executable,
      name: preSignedUrl.fileName,
      external_url: `${baseGateWayURL}/${location}`,
      downloadSize,
      installSize: downloadSize,
      installScript: platformEntry.installScript,
    };
  }

  CliUx.ux.action.stop();
  return meta;
}
