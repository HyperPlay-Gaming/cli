import fs from 'fs';
import archiver from 'archiver';
import { CliUx } from '@oclif/core';

export function zipDirectory(sourceDir: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    // Use function references for easier cleanup
    const onProgress = (progress: { entries: { processed: number; total: number }; fs: { processedBytes: number; totalBytes: number } }) => {
      let progressString = `Zip Progress: Entries ${progress.entries.processed} out of ${progress.entries.total}.`;
      progressString += ` Bytes ${progress.fs.processedBytes} out of ${progress.fs.totalBytes}`;
      CliUx.ux.log(progressString);
    };

    const onClose = () => {
      console.log(`Archive created successfully. Total bytes: ${archive.pointer()}`);
      cleanup();
      resolve();
    };

    const onWarning = (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') {
        console.warn(err);
      } else {
        cleanup();
        reject(err);
      }
    };

    const onError = (err: Error) => {
      CliUx.ux.error(err);
      cleanup();
      reject(err);
    };

    const onOutputError = (err: Error) => {
      cleanup();
      reject(err);
    };

    // Clean up all event listeners
    const cleanup = () => {
      archive.removeListener('progress', onProgress);
      archive.removeListener('warning', onWarning);
      archive.removeListener('error', onError);
      output.removeListener('close', onClose);
      output.removeListener('error', onOutputError);
    };

    // Add event listeners
    archive.on('progress', onProgress);
    archive.on('warning', onWarning);
    archive.on('error', onError);
    output.on('close', onClose);
    output.on('error', onOutputError);

    archive.pipe(output);

    // Append files from the source directory, preserving directory structure.
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}