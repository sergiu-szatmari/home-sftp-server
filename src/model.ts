import { utils } from 'ssh2';
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

// Easier import & usage of the enums instead of ("import utils from 'ssh2'" & "utils.sftp.STATUS_CODE.OK")
export { STATUS_CODE, OPEN_MODE };

export type FileHandle = number;
export type FileData = {
  path: string; // Path for file or directory
  fullPath: string; // Absolute path related to system's file system

  isDirectory: boolean;
  files: string[]; // Is relevant only if "this.isDirectory"
  offset: number; // Is relevant only if "this.isDirectory"
  // ...
}

export enum SFTPEvent {
  OPEN = 'OPEN',
  READ = 'READ',
  WRITE = 'WRITE',
  FSTAT = 'FSTAT',
  FSETSTAT = 'FSETSTAT',
  CLOSE = 'CLOSE',
  OPENDIR = 'OPENDIR',
  READDIR = 'READDIR',
  LSTAT = 'LSTAT',
  STAT = 'STAT',
  REMOVE = 'REMOVE',
  RMDIR = 'RMDIR',
  REALPATH = 'REALPATH',
  READLINK = 'READLINK',
  SETSTAT = 'SETSTAT',
  MKDIR = 'MKDIR',
  RENAME = 'RENAME',
  SYMLINK = 'SYMLINK',
}

export type OpenFileManagement = Map<FileHandle, FileData>;
