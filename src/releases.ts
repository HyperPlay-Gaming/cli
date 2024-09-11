import path from "path";
import fs from "fs";
import mime from "mime-types";
import { CliUx } from '@oclif/core';
import { ReleaseMeta } from "@valist/sdk";
import { SupportedPlatform } from '@valist/sdk/dist/typesShared';
import { zipDirectory } from './zip';
import { ReleaseConfig } from './types';
import { getZipName } from './utils/getZipName';
import { getSignedUploadUrls, uploadFileS3 } from '@valist/sdk/dist/s3';
import { AxiosInstance } from 'axios';

interface PlatformEntry {
  platform: string;
  path: string;
  installScript: string;
  executable: string;
}

const baseGateWayURL = `https://gateway-b3.valist.io`;

export async function uploadRelease(client: AxiosInstance, config: ReleaseConfig) {
  const updatedPlatformEntries: PlatformEntry[] = await Promise.all(Object.entries(config.platforms).map(async ([platform, platformConfig]) => {
    const installScript = platformConfig.installScript;
    const executable = platformConfig.executable;

    if (config && config.platforms[platform] && !config.platforms[platform].zip) {
      return { platform, path: platformConfig.path, installScript, executable };
    }

    const zipPath = getZipName(platformConfig.path);
    CliUx.ux.action.start(`Zipping ${zipPath}`);
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

  CliUx.ux.action.start('Uploading files');

  for (const platformEntry of updatedPlatformEntries) {
    const platformKey = platformEntry.platform as SupportedPlatform;
    const { path: platformPath, executable } = platformEntry;

    // Handle WebGL folder upload, otherwise treat as a single file
    const isWebGL = platformKey === 'webgl';
    const files = isWebGL ? await getFolderFiles(platformPath) : await getSingleFile(platformPath);

    CliUx.ux.action.start(`Generating presigned URLs for ${platformKey}`);
    const urls = await getSignedUploadUrls({
      account: config.account,
      project: config.project,
      release: config.release,
      platform: platformKey,
      files: files.map(file => ({
        fileName: file.fileName,
        fileType: mime.lookup(file.filePath) || 'application/octet-stream',
        fileSize: file.fileSize,
      })),
      type: "release",
    }, { client });
    CliUx.ux.action.stop();

    for (const url of urls) {
      const fileData = isWebGL ? files.find(f => f.fileName === url.fileName)?.filePath : platformPath;
      if (!fileData) throw new Error(`File data not found for ${url.fileName}`);

      const fileType = mime.lookup(fileData) || 'application/octet-stream';
      const progressIterator = uploadFileS3(
        fs.createReadStream(fileData),
        url.uploadId,
        url.key,
        url.partUrls,
        fileType,
        { client }
      );

      let location = '';
      for await (const progressUpdate of progressIterator) {
        if (typeof progressUpdate === 'number') {
          CliUx.ux.log(`Upload progress for ${platformKey} - ${url.fileName}: ${progressUpdate}%`);
        } else {
          location = progressUpdate;
        }
      }

      if (!location) throw new Error('No location returned after upload');

      const fileStat = await fs.promises.stat(fileData);
      const downloadSize = fileStat.size.toString();

      // Add platform metadata after successful upload
      meta.platforms[platformKey] = {
        executable,
        name: url.fileName,
        external_url: `${baseGateWayURL}${location}`,
        downloadSize,
        installSize: downloadSize,
        installScript: platformEntry.installScript,
      };
    }
  }

  CliUx.ux.action.stop();
  return meta;
}

// Helper function to gather all files in a folder for WebGL uploads
async function getFolderFiles(folderPath: string): Promise<Array<{ fileName: string, filePath: string, fileSize: number }>> {
  const fileList: Array<{ fileName: string, filePath: string, fileSize: number }> = [];

  async function walkDirectory(currentPath: string) {
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walkDirectory(entryPath);
      } else {
        const fileSize = (await fs.promises.stat(entryPath)).size;
        fileList.push({
          fileName: path.relative(folderPath, entryPath),
          filePath: entryPath,
          fileSize,
        });
      }
    }
  }

  await walkDirectory(folderPath);
  return fileList;
}

// Helper function for single file uploads
async function getSingleFile(filePath: string): Promise<Array<{ fileName: string, filePath: string, fileSize: number }>> {
  const fileSize = (await fs.promises.stat(filePath)).size;
  const fileName = path.basename(filePath);

  return [{
    fileName,
    filePath,
    fileSize,
  }];
}
