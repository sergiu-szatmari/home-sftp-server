import {
  constants as fsConstants,
  existsSync as fsExistsSync,
  mkdirSync as fsMkDirSync,
} from 'fs';
import config from './config';
import { join as pathJoin } from 'path';

// Directory permissions ==> "rwx|r-x|r-x"
export const DIR_PERMISSIONS = 0o755;

// Regular file permissions ==> "rw-|r--|r--"
export const FILE_PERMISSIONS = 0o644;

// Helper function that converts a "mode" from SFTP format to FileSystem format
function convertMode_SFTP_to_FS(sftpMode: number): number {
  let fsMode = 0;

  // 1. Determine file type (directory / file)
  const isDirectory = !!(sftpMode & fsConstants.S_IFDIR);

  // 2. Set corresponding bits
  if (isDirectory) {
    fsMode = (fsMode | fsConstants.S_IFDIR);
  } else {
    fsMode = (fsMode | fsConstants.S_IFREG);
  }
  
  // 3. Extract permissions from SFTP mode (last 9 bits)
  const permissionBits = sftpMode & 0o777;

  // 4. Add permissions to FS mode
  fsMode = fsMode | permissionBits;

  // 5. Return converted mode
  return fsMode;
}

// Helper function that converts a "mode" from FS format to SFTP format
function convertMode_FS_to_SFTP(fsMode: number): number {
  let sftpMode = 0;

  // 1. Check bitwise mask to determine file type (dir/file)
  const isDirectory = !!(fsMode & fsConstants.S_IFDIR)

  // 2. Assign proper mode and permissions
  if (isDirectory) {
    // Mark as directory with 755 permissions
    sftpMode = fsConstants.S_IFDIR | DIR_PERMISSIONS;
  }  else {
    // Mark as regular file with 644 permissions 
    sftpMode = fsConstants.S_IFREG | FILE_PERMISSIONS
  }

  // 3. Return converted mode
  return sftpMode;
}

export enum ModeConversion {
  // SFTP mode ==> FS mode
  sftp2fs = 'sftp2fs',

  // FS mode ==> SFTP mode
  fs2sftp = 'fs2sftp',
}
export function getModeConvertor(type: ModeConversion) {
  switch (type) {
    case ModeConversion.sftp2fs: return convertMode_SFTP_to_FS;
    case ModeConversion.fs2sftp: return convertMode_FS_to_SFTP;
    default: throw new Error(`Unhandled conversion mode "${type}"`);
  } 
}

export class Mutex {
  private mutex: Promise<void> = Promise.resolve();

  // Locks the critical section, returns a release function when done
  public async lock(): Promise<() => void> {
      let release: () => void;
      
      const currentMutex = this.mutex;
      this.mutex = new Promise<void>(resolve => release = resolve);

      await currentMutex; // Wait for the previous lock to be released
      return release!; // Return the release function
  }
}

// Things to be done before the SFTP server is initiated and starts listening
export function runPrerequisiteActions() {

  // 1. Validate DATA_DIR_PARENT path
  let isDirectoryPresent = fsExistsSync(config.dataDirParent);
  if (!isDirectoryPresent) throw new Error(`Path of DATA_DIR_PARENT is invalid "${config.dataDirParent}"`);

  console.log(`[Prerequisites] DATA_PARENT_DIR exists at "${config.dataDirParent}"`);

  // 2. Validate DATA_DIR_PARENT/DATA_DIR path
  const dataDirFullPath = pathJoin(config.dataDirParent, `/${config.dataDirName}`);
  console.log(`[Prerequisites] Data directory full path "${dataDirFullPath}"`);

  // 3. Ensure DATA dir
  isDirectoryPresent = fsExistsSync(dataDirFullPath);
  if (isDirectoryPresent) {
    console.log(`[Prerequisites] Data directory exists at path "${dataDirFullPath}"`);
  } else {
    console.log(`[Prerequisites] Data directory does not exist at path "${dataDirFullPath}"`);
    console.log(`[Prerequisites] Creating data directory...`);
  
    // Create directory
    fsMkDirSync(dataDirFullPath, DIR_PERMISSIONS);
  
    // Check if directory was created successfully
    isDirectoryPresent = fsExistsSync(dataDirFullPath);
    if (!isDirectoryPresent) throw new Error(`Failed to create data directory at "${dataDirFullPath}"`);
    else console.log(`[Prerequisites] Successfully created data directory`);
  }
}