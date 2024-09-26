import { AcceptConnection, Attributes, AuthContext, ClientInfo, Connection, FileEntry, Session, SFTPWrapper, utils } from 'ssh2';
import { timingSafeEqual } from 'crypto'
import { join as pathJoin, normalize as pathNormalize } from 'path';
import {
  existsSync as fspExistsSync,
  createWriteStream as fspCreateWriteStream,
  createReadStream as fspCreateReadStream,
  constants as fsConstants,
} from 'fs';
import {
  stat as fspStat,
  lstat as fspLStat,
  chmod as fspChmod,
  chown as fspChown,
  utimes as fspUtimes,
  readdir as fspReaddir,
  mkdir as fspMkdir,
  rename as fspRename,
  rm as fspRm
} from 'fs/promises';

import config from './config';
import { OpenFileManagement, SFTPEvent, STATUS_CODE } from './model';
import { DIR_PERMISSIONS, getModeConvertor, ModeConversion, Mutex } from './utils';

const { allowedUser, allowedPassword, dataDirName } = config;

// "/data" or "/data-sftp" or ...
const dataDirBasePath = `/${dataDirName}`


class SFTPStreamControlller {
  protected openFiles: OpenFileManagement = new Map();
  protected handleCount = 0;

  private _ROOT = config.dataDirParent;
  private readDirMutex = new Mutex();

  protected debug() {
    const entries: string[] = [];
    this.openFiles.forEach((val, key) => entries.push(`#${key} -> ${JSON.stringify(val)}`));
    console.log([
      '------- Open Files Handlers -------',
      ...entries,
      '-----------------------------------',
      '',
      ''
    ].join('\n'));
  }

  // OPEN - Triggered when the SFTP client attempts to open a file/directory
  public onOpen = (sftp: SFTPWrapper) => {
    return async (reqId: number, filename: string, flags: number, attrs: Attributes) => {
      try {
        // Convert bitwise flags to string (e.g. 58 -> "wx")
        const stringFlags = utils.sftp.flagsToString(flags);
        if (!stringFlags) {
          console.log(`[OPEN] Error converting flags to string (flags: "${flags}")`);
          return sftp.status(reqId, STATUS_CODE.FAILURE);
        }  
        
        // Compute the "full path" (of file, as it is found in the system) from the "relative" path to 
        const fullPath = pathJoin(this._ROOT, filename);
        console.log(`[OPEN] reqId=${reqId}; filename=${filename}; fullPath=${fullPath}; flags=${flags} ("${stringFlags}"); attrs=${JSON.stringify(attrs)}`);
        
        // Create a handleId from buffer so it can be used later
        const handle = Buffer.alloc(4);

        // Check if file exists (for later use)
        const fileExists = fspExistsSync(fullPath);

        // If opening mode is READ
        if (stringFlags.includes('r')) {
          if (!fileExists) {
            // ...and fail the request if it doesn't exist
            console.log(`[OPEN] Error: file not found (path: "${fullPath}")`);
            return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
          }

          // File exists, so get file stats and handle accordingly
          const stats = await fspStat(fullPath);
          const isDirectory = stats.isDirectory();

          // Set entry in opened files Map
          this.openFiles.set(this.handleCount, {
            path: filename, fullPath,
            isDirectory, files: [], offset: 0,
          });

          // Write handler and increment counter for next usage
          handle.writeUInt32BE(this.handleCount, 0);
          this.handleCount++;

          console.log(`[OPEN] ${isDirectory ? 'Directory' : 'File'} opened "${filename}" (full path: "${fullPath}")`);
          this.debug()

          return sftp.handle(reqId, handle)
        } else if (stringFlags.includes('w')) {
          // If opening mode is WRITE
          
          const writeStream = fspCreateWriteStream(fullPath, {
            mode: 0o755,
            // flags: stringFlags,
            encoding: 'utf8'
          });

          // Handle error event
          writeStream.on('error', (err) => {
            console.warn(`[OPEN] Error creating file "${filename}" (full: "${fullPath}")`);
            console.error(err);
            return sftp.status(reqId, STATUS_CODE.FAILURE)
          });

          // Write empty string to newly created file
          writeStream.write('');
          writeStream.end(async () => {
            // After the stream closes, get file stats and pass those to sftp client
            const stats = await fspStat(fullPath);
            const isDirectory = stats.isDirectory();

            // Set entry in opened files Map
            this.openFiles.set(this.handleCount, {
              path: filename, fullPath,
              isDirectory, files: [], offset: 0,
            });

            // Write handler and increment counter for next usage
            handle.writeUInt32BE(this.handleCount, 0);
            this.handleCount++;

            console.log(`[OPEN] ${isDirectory ? 'Directory' : 'File'} opened "${filename}" (full path: "${fullPath}")`);
            this.debug()

            return sftp.handle(reqId, handle)
          });
        } else {
          // Handle invalid/unsupported request
          console.log(`[OPEN] Invalid/unsupported request "${filename}" (fullPath: "${fullPath}"; flags: "${flags}")`);
          return sftp.status(reqId, STATUS_CODE.FAILURE);
        }

      } catch (err) {
        console.log(`[OPEN] Error occurred when opening file/dir at "${filename}"`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }  
    }; 
  };

  // CLOSE - Triggered when the SFTP client closes a handle for a file/directory
  public onClose = (sftp: SFTPWrapper) => {
    return async (reqId: number, handle: Buffer) => {
      // Read/extract the HandleId from the buffer
      const handleId = handle.readUInt32BE(0);
      const openFileEntry = this.openFiles.get(handleId);

      if (!openFileEntry) {
        console.log(`[CLOSE] No entry found in OpenFiles map. reqId=${reqId}; handleId=${handleId}`);
        return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        // return sftp.status(reqId, STATUS_CODE.FAILURE);
      }

      console.log(`[CLOSE] Closing file/dir handler; reqId=${reqId}; path=${openFileEntry.path}; isDirectory=${openFileEntry.isDirectory}; handleId=${handleId}`);
      
      // Remove handler from Handler Map
      this.openFiles.delete(handleId);
      this.debug();

      // Return status to SFTP client
      return sftp.status(reqId, STATUS_CODE.OK);
    }
  };

  // READDIR - Triggered when the SFTP client asks for a directory listing
  public onReadDir = (sftp: SFTPWrapper) => {
    // Disclaimer:
    //    Filezilla emits a few READDIR events concurrently. This behaviour makes the directory listing to have each file displayed [EMIT COUNT] amount of times.
    //    To fix this behaviour, we use a Mutex. This limits the function execution to only one event handler at a time.
    return async (reqId: number, handle: Buffer) => {
      // Acquire mutex lock
      const releaseMutex = await this.readDirMutex.lock();

      // Read/extract the HandleId from the buffer
      const handleId = handle.readUInt32BE(0);
      const openFileEntry = this.openFiles.get(handleId);
      console.log(`[READDIR] reqId=${reqId}; handleId=${handleId}; entry.offset=${openFileEntry?.offset}`)
      
      if (!openFileEntry || !openFileEntry.isDirectory) {
        console.log(`[READDIR] Invalid directory handle; reqId=${reqId}, handleId=${handleId}, path=${openFileEntry?.path}`);
        releaseMutex(); // Release mutex lock
        return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
      }
      
      try {
        // Check if directory wasn't listed before (to prevent an infinite READDIR emit)
        const { files, offset } = openFileEntry;
        
        // If no more files to send
        if (offset >= files.length) {
          console.log(`[READDIR] End of listing (from before)`);
          releaseMutex(); // Release mutex lock
          return sftp.status(reqId, STATUS_CODE.EOF);
        }
        
        // Compose batch of entries & get stats for each file to be sent
        const batchSize = 10;
        const entries = await Promise.all(
          files
            .slice(offset, offset + batchSize)
            .map(async (file): Promise<FileEntry> => {
              // Compute full path, relative to "openFileEntry.fullPath"
              const fullPath = pathJoin(openFileEntry.fullPath, file);
              
              // Get stats for every file
              const stats = await fspStat(fullPath);
              const { mode, uid, gid, size, atimeMs: atime, mtimeMs: mtime } = stats;
              
              const convertMode = getModeConvertor(ModeConversion.fs2sftp);
              const sftpMode = convertMode(mode); 

              const attrs: Attributes = { mode: sftpMode, uid, gid, size, atime, mtime }; 
              return { filename: file, longname: '', attrs };
            })
        );

        console.log(`[READDIR] Listing directory "${openFileEntry.path}": ${JSON.stringify(entries)}]`);

        // Update offset for the next READDIR handler
        openFileEntry.offset += entries.length;
        
        // Release mutex lock
        releaseMutex();
        
        // Send files
        return sftp.name(reqId, entries);
      } catch (err) {
        console.log(`[READDIR] Error occurred`);
        console.error(err);
        releaseMutex(); // Release mutex lock
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

  // REALPATH - Triggered when the SFTP client connects and wants to find out their "path" in the SFTP Server's file system; Also, it's triggered when the SFTP client has to resolve a (new) path in the server's file system (e.g. creating a new directory -- firstly, the client must check if the path of new dir is valid, via REALPATH)
  public onRealPath = (sftp: SFTPWrapper) => {
    return async (reqId: number, requestedPath: string) => {
      console.log(`[REALPATH] reqId=${reqId}, requestedPath=${requestedPath}`);

      requestedPath = pathNormalize(requestedPath)
      console.log(`[REALPATH] Normalized path=${requestedPath}`);

      // Handling scenarios when the REALPATH event can be emitted
      const realPath = (() => {
        // Case 1: Initial connection to SFTP Server
        //  - SFTP client tries to resolve the 'root' path (sends either "." or "/")
        //  - The server must "resolve" the root path "[dataDirBasePath]"
        if (requestedPath === '.') return dataDirBasePath;
        if (requestedPath === '/') return dataDirBasePath;

        // Case 2: Subsequest connection to SFTP Server
        //  - SFTP client tries to check if certain path is valid on Server's file system

        // Deny any path above "[dataDirBasePath]" and fallback to the "root" directory "[dataDirBasePath]" 
        if (!requestedPath.startsWith(dataDirBasePath)) return dataDirBasePath;
        
        // We have ensured that the path is under "[dataDirBasePath][/......]"
        return requestedPath;
      })();
      const fullPath = pathJoin(this._ROOT, realPath);
      console.log(`[REALPATH] realPath=${realPath}; fullPath=${fullPath}`);

      try {
        // Getting attributes for the path
        const stats = await fspStat(fullPath);

        const convertMode = getModeConvertor(ModeConversion.fs2sftp);
        const sftpMode = convertMode(stats.mode);

        // If path exists, prepare the attributes object to be sent to SFTP client
        const attrs: Attributes = {
          mode: sftpMode,
          uid: stats.uid,
          gid: stats.gid,
          size: stats.size,
          atime: stats.atimeMs,
          mtime: stats.mtimeMs
        };

        // Returning successful response to client
        return sftp.name(reqId, [{ filename: realPath, longname: '', attrs }]);
      } catch (err: NodeJS.ErrnoException | any) {
        // Nothing exists at given path, but it's likely a request to create a directory
        // Inform SFTP client that the path is valid to proceed
        if (err.code === 'ENOENT') {
          return sftp.name(reqId, [{ filename: realPath, longname: '', attrs: { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }}]);
        }

        console.log(`[REALPATH] Error occurred when getting attributes for "${realPath}" (full path: "${fullPath}")`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
      }
    };
  };

  // OPENDIR - Triggered when a directory is opened in the SFTP client; this handler ensures that the dir's contents are read and stored for later, when the READDIR event is emitted
  public onOpenDir = (sftp: SFTPWrapper) => {
    return async (reqId: number, path: string) => {
      console.log(`[OPENDIR] reqId=${reqId}, path=${path}`);

      try {
        // Path normalization
        path = pathNormalize(path);
        const fullPath = pathJoin(this._ROOT, path);
        console.log(`[OPENDIR] Normalized path="${path}"; fullPath="${fullPath}"`);

        // Ensure "fullPath" is actually a directory
        const stats = await fspStat(fullPath);
        if (!stats.isDirectory()) {
          console.error(`[OPENDIR] Path "${path}" is not a directory`);
          return sftp.status(reqId, STATUS_CODE.FAILURE);
        }

        // Get files from the directory
        const files = await fspReaddir(fullPath, 'utf8');

        // Create & assign handle for directory
        const handle = Buffer.alloc(4);
        this.openFiles.set(this.handleCount, {
          path, fullPath,
          isDirectory: true, files, offset: 0,
        })
        handle.writeUInt32BE(this.handleCount, 0);
        this.handleCount++;

        console.log(`[OPENDIR] Directory opened "${path}"`)
        this.debug();

        return sftp.handle(reqId, handle);
      } catch (err) {
        console.log(`[OPENDIR] Error occurred when opening dir "${path}"`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

  // WRITE - Triggered when the SFTP client attempts writing content to a file
  public onWrite = (sftp: SFTPWrapper) => {
    return async (reqId: number, handle: Buffer, offset: number, data: Buffer) => {
      const handleId = handle.readUInt32BE(0);
      const openFileEntry = this.openFiles.get(handleId);
      console.log(`[WRITE] reqId=${reqId}; handleId=${handleId}; offset=${offset}; data.length=${data.length}`)

      if (!openFileEntry) {
        console.log(`[WRITE] No entry found for handle "${handleId}"`);
        return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
      }

      try {
        const stream = fspCreateWriteStream(openFileEntry.fullPath, {
          encoding: 'utf8',
          start: offset,
          flags: 'w',
          mode: 0o755,
        });
        stream.write(data);
        stream.end();

        // await fs.writeFile(openFileEntry.fullPath, data, { encoding: 'utf8' });
        console.log(`[WRITE] Successfully written file "${openFileEntry.fullPath}"`);

        return sftp.status(reqId, STATUS_CODE.OK);
      } catch(err) {
        console.log(`[WRITE] Error occurred while writing to file "${openFileEntry.fullPath}" (reqId=${reqId}, handleId=${handleId})`)
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

  // SETSTAT - Triggered after an SFTP client creates/updates a file and attempts to set/update the permissions and/or timestamps
  public onSetStat = (sftp: SFTPWrapper) => {
    return async (reqId: number, filePath: string, attrs: Attributes) => {
      console.log(`[SETSTAT] reqId=${reqId}; filePath=${filePath}; attrs=${JSON.stringify(attrs)}`);
            
      try {
        // Path normalization
        filePath = pathNormalize(filePath);
        console.log(`[SETSTAT] normalizedPath=${filePath}`);
        
        const fullPath = pathJoin(this._ROOT, filePath);
        
        // Check if file exists and get current stats
        const stats = await fspStat(fullPath);
        const { mode, uid, gid, atime, mtime } = stats;

        // Set permissions if provided
        if (mode !== undefined) {
          const convertMode = getModeConvertor(ModeConversion.sftp2fs);
          const fsMode = convertMode(mode);
          await fspChmod(fullPath, fsMode);
        }

        // Set ownership if provided
        if (uid !== undefined && gid !== undefined) {
          await fspChown(fullPath, uid, gid);
        }

        // Set timestamps if provided
        if (atime !== undefined && mtime !== undefined) {
          await fspUtimes(fullPath, atime, mtime);
        }

        // Send success response to SFTP client
        return sftp.status(reqId, STATUS_CODE.OK);
      } catch (err) {
        console.log(`[SETSTAT] Error occurred; reqId=${reqId}; filePath=${filePath}; attrs=${JSON.stringify(attrs)}`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

  // MKDIR - Triggered when SFTP client attempts to create a new directory on the SFTP server
  public onMkDir = (sftp: SFTPWrapper) => {
    return async (reqId: number, path: string, attrs: Attributes) => {
      console.log(`[MKDIR] reqId=${reqId}; path=${path}; attrs=${JSON.stringify(attrs)}`);

      try {
        // Path normalization
        path = pathNormalize(path);
        console.log(`[MKDIR] normalizedPath=${path}`);
  
        const fullPath = pathJoin(this._ROOT, path);

        // Check if another directory with the same name already exists
        const isDirectoryPresent = fspExistsSync(fullPath);
        if (isDirectoryPresent) {
          console.log(`[MKDIR] Directory with the given name already exists at "${path}" (full path: "${fullPath}")`);
          return sftp.status(reqId, STATUS_CODE.FAILURE);
        }

        let fsMode = 0;
        if (attrs.mode !== undefined) {
          // Convert mode if provided by sftp client
          const convertMode = getModeConvertor(ModeConversion.sftp2fs);
          fsMode = convertMode(attrs.mode);
        } else {
          // Default value if nothing was provided
          fsMode = DIR_PERMISSIONS | fsConstants.S_IFDIR;
        }

        await fspMkdir(fullPath, fsMode);
        if (!fspExistsSync(fullPath)) {
          console.log(`[MKDIR] Creating directory failed at path "${path}" (full path: "${fullPath}")`);
          return sftp.status(reqId, STATUS_CODE.FAILURE);
        }

        // Set directory attributes:
        await fspChmod(fullPath, fsMode); // permissions
        await fspChown(fullPath, process.getuid!(), process.getgid!()); // ownership
        await fspUtimes(fullPath, Date.now(), Date.now()) // timestamps

        // Use this to indicate success/failure of the creation of the directory at path.
        return sftp.status(reqId, STATUS_CODE.OK);
      } catch (err) {
        console.log(`[MKDIR] Error occurred when creating a new directory and/or settings attributes at "${path}"`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    }
  };

  // RENAME - Triggered when the SFTP client attempts to rename a file/directory on the remote SFTP server
  public onRename = (sftp: SFTPWrapper) => {
    return async (reqId: number, oldPath: string, newPath: string) => {
      console.log(`[RENAME] reqId=${reqId}; oldPath=${oldPath}; newPath=${newPath}`);

      try {
        // Path normalizations
        oldPath = pathNormalize(oldPath);
        newPath = pathNormalize(newPath);

        const oldFullPath = pathJoin(this._ROOT, oldPath);
        const newFullPath = pathJoin(this._ROOT, newPath);
        console.log(`[RENAME] Normalized paths -- oldPath="${oldPath}" (full: "${oldFullPath}"); newPath="${newPath}" (full: "${newFullPath}")`);

        // Check if the "oldPath" file exists
        const isFilePresesent = fspExistsSync(oldFullPath);
        if (!isFilePresesent) {
          console.log(`[RENAME] File does not exist "${oldPath}" (full: "${oldFullPath}")`);
          return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        }

        // Check if the "newPath" file already exists
        const isNewNameAlreadyUsed = fspExistsSync(newFullPath);
        if (isNewNameAlreadyUsed) {
          console.log(`[RENAME] New name is already used by file "${newPath}" (full: "${newFullPath}")`);
          return sftp.status(reqId, STATUS_CODE.FAILURE);
        }

        // Rename file
        await fspRename(oldFullPath, newFullPath);
        const isOldFilePresent = fspExistsSync(oldFullPath);
        if (isOldFilePresent) {
          console.log(`[RENAME] Rename file failed -- old file exists after rename (oldPath="${oldPath}"; newPath="${newPath}")`);
          return sftp.status(reqId, STATUS_CODE.FAILURE);
        }
        
        // Return "OK" to client
        return sftp.status(reqId, STATUS_CODE.OK);
      } catch (err) {
        console.log(`[RENAME] Error occurred when renaming oldPath "${oldPath}" to newPath "${newPath}"`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }  
    };
  };

  // REMOVE - Triggered when the SFTP client attempts to delete a file
  public onRemove = (sftp: SFTPWrapper) => {
    return async (reqId: number, path: string) => {
      console.log(`[REMOVE] reqId=${reqId}; path=${path}`);

      try {
        // Path normalization
        path = pathNormalize(path);
        const fullPath = pathJoin(this._ROOT, path);
        console.log(`[REMOVE] Normalized path: "${path}"; Full path: "${fullPath}"`);
        
        // Check if file exists
        let isFilePresesent = fspExistsSync(fullPath);
        if (!isFilePresesent) {
          console.log(`[REMOVE] File does not exist "${path}" (full path: "${fullPath}")`);
          return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        }

        // Attempt to delete file
        await fspRm(fullPath, { force: true, recursive: true });

        // Check if file was truly removed (since fs.remove/fs.unlink don't return any success status)
        isFilePresesent = fspExistsSync(fullPath);
        if (isFilePresesent) {
          console.log(`[REMOVE] File deletion failed -- file is still present in the file system at "${path}" (full path: "${fullPath}")`);
          return sftp.status(reqId, STATUS_CODE.FAILURE);
        }

        // File is deleted, return success to SFTP client
        return sftp.status(reqId, STATUS_CODE.OK);
      } catch (err) {
        console.log(`[REMOVE] Error occurred when removing file at "${path}"`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

  // [Unsupported] SYMLINK - Triggered when the SFTP client attemps to create a symbolic link
  public onSymlink = (sftp: SFTPWrapper) => {
    return (reqId: number, linkPath: string, targetPath: string) => {
      console.log(`[SYMLINK] Unsupported operation; reqId=${reqId}; linkPath="${linkPath}"; targetPath="${targetPath}"`);
      return sftp.status(reqId, STATUS_CODE.OP_UNSUPPORTED);  
    };
  };

  // [Unsupported] READLINK - Triggered when the SFTP client attempts to read a symbolic link
  public onReadLink = (sftp: SFTPWrapper) => {
    return (reqId: number, path: string) => {
      console.log(`[SYMLINK] Unsupported operation; reqId=${reqId}; path="${path}"`);
      return sftp.status(reqId, STATUS_CODE.OP_UNSUPPORTED);  
    };
  };

  // READ - Triggered when the SFTP client requests a chunk of data from a file (in order to copy a file FROM server to remote client?)
  public onRead = (sftp: SFTPWrapper) => {
    return async (reqId: number, handle: Buffer, offset: number, length: number) => {
      // Read/extract the HandleId from the buffer
      const handleId = handle.readUInt32BE(0);
      const openFileEntry = this.openFiles.get(handleId);
      
      if (!openFileEntry) {
        console.log(`[OPEN] No entry found in OpenFilesManagement map. reqId=${reqId}; handleId=${handleId}`);
        return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        // return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
      
      console.log(`[READ] Reading file; reqId=${reqId}; handleId=${handleId}; fullPath="${openFileEntry.fullPath}"`);
      
      // Ensure file exists and also get file size
      const stats = await fspStat(openFileEntry.fullPath);
      
      // Check if file transfer is already finished (sentBytes > fileSize)
      if (offset > stats.size) {
        console.log(`[READ] File transfer (read) already finished (full path: "${openFileEntry.fullPath}")`);
        return sftp.status(reqId, STATUS_CODE.EOF);
      }

      // Read file as stream
      const readStream = fspCreateReadStream(openFileEntry.fullPath, {
        flags: 'r',
        start: offset,
        end: offset + length - 1, // The end is inclusive; Also stream is autoClosable if 'end' is provided
        mode: 0o755,
      });

      // Data accumulator buffer
      let data = Buffer.alloc(0);

      // Handle potential reading errors
      readStream.on('error', (err) => {
        console.log(`[READ] Error occurred in stream while reading file at "${openFileEntry.fullPath}"`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      })

      // Concatenate data chunks as they are read in ReadStream
      readStream.on('data', (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
      });

      // On finished reading, send data to client
      readStream.on('end', () => {
        console.log(`[READ] Read ${readStream.bytesRead} bytes from file at "${openFileEntry.fullPath}"`);
        return sftp.data(reqId, data);
      });
    };
  };

  // STAT - Triggered when the SFTP client requests the attributes/metadata for a file/directory
  public onStat = (sftp: SFTPWrapper) => {
    return async (reqId: number, path: string) => {
      console.log(`[STAT] reqId=${reqId}; path="${path}"`);

      try {
        // Path normalization
        path = pathNormalize(path);
        const fullPath = pathJoin(this._ROOT, path);
        console.log(`[STAT] Normalized path="${path}"; fullPath="${fullPath}"`);

        // Check if file/dir exists
        const isPathValid = fspExistsSync(fullPath);
        if (!isPathValid) {
          console.log(`[STAT] Invalid path -- file not found at "${path}" (fullPath="${fullPath}")`);
          return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        }

        // Get file/dir stats && compose attributes response object
        const stats = await fspStat(fullPath);
        
        const convertMode = getModeConvertor(ModeConversion.fs2sftp);
        const sftpMode = convertMode(stats.mode);
        
        const attrs: Attributes = {
          mode: sftpMode,
          uid: stats.uid,
          gid: stats.gid,
          size: stats.size,
          atime: stats.atimeMs,
          mtime: stats.mtimeMs
        };

        // Return attributes to client
        return sftp.attrs(reqId, attrs)
      } catch (err) {
        console.log(`[STAT] Error occurred`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

  // FSTAT - Similar to STAT, but works with a FileHandle instead of path; Triggered when the SFTP client requests the attributes/metadata for a file/directory
  public onFStat = (sftp: SFTPWrapper) => {
    return async (reqId: number, handle: Buffer) => {
      try {
        // Read/extract the HandleId from the buffer
        const handleId = handle.readUInt32BE(0);
        const openFileEntry = this.openFiles.get(handleId);
        
        if (!openFileEntry) {
          console.log(`[FSTAT] Invalid handle; reqId=${reqId}, handleId=${handleId}`);
          return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        }
        
        const { fullPath } = openFileEntry;
        console.log(`[FSTAT] reqId=${reqId}; handleId=${handleId}; fullPath="${fullPath}"`);
        

        // Get file/dir stats && compose attributes response object
        const stats = await fspStat(fullPath);
        
        const convertMode = getModeConvertor(ModeConversion.fs2sftp);
        const sftpMode = convertMode(stats.mode);
        
        const attrs: Attributes = {
          mode: sftpMode,
          uid: stats.uid,
          gid: stats.gid,
          size: stats.size,
          atime: stats.atimeMs,
          mtime: stats.mtimeMs
        };

        // Return attributes to client
        return sftp.attrs(reqId, attrs);
      } catch (err) {
        console.log(`[FSTAT] Error occurred`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

  // FSETSTAT - Similar to SETSTAT, but works with a FileHandle instead of a path; Triggered when the SFTP client attempts to set/update the file metadata (permissions, ownership and/or timestamps)
  public onFSetStat = (sftp: SFTPWrapper) => {
    return async (reqId: number, handle: Buffer, attrs: Attributes) => {
      try {
        // Read/extract the HandleId from the buffer
        const handleId = handle.readUInt32BE(0);
        const openFileEntry = this.openFiles.get(handleId);
        
        if (!openFileEntry) {
          console.log(`[FSETSTAT] Invalid handle; reqId=${reqId}, handleId=${handleId}`);
          return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        }
        
        const { fullPath } = openFileEntry;
        console.log(`[FSETSTAT] reqId=${reqId}; handleId=${handleId}; fullPath="${fullPath}"; attrs=${JSON.stringify(attrs)}`);
        

        // Set permissions if provided
        if (attrs.mode !== undefined) {
          const convertMode = getModeConvertor(ModeConversion.sftp2fs);
          const fsMode = convertMode(attrs.mode);
          await fspChmod(fullPath, fsMode);
        }

        // Set ownership if provided
        if (attrs.uid !== undefined && attrs.gid !== undefined) {
          await fspChown(fullPath, attrs.uid, attrs.gid);
        }

        // Set timestamps if provided
        if (attrs.atime !== undefined && attrs.mtime !== undefined) {
          await fspUtimes(fullPath, attrs.atime, attrs.mtime);
        }

        // Send success response to SFTP client
        return sftp.status(reqId, STATUS_CODE.OK);
      } catch (err) {
        console.log(`[FSETSTAT] Error occurred`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

  // LSTAT - Triggered when the SFTP client requests the attributes/metadata for a file/directory SYMLINK, not the file/dir itself
  public onLStat = (sftp: SFTPWrapper) => {
    return async (reqId: number, path: string) => {
      console.log(`[LSTAT] reqId=${reqId}, path="${path}"`);

      try {
        // Path normalization
        path = pathNormalize(path);
        const fullPath = pathJoin(this._ROOT, path);
        console.log(`[LSTAT] Normalized path="${path}" (fullPath="${fullPath}")`);

        // Check if path is valid
        const isPathValid = fspExistsSync(fullPath);
        if (!isPathValid) {
          console.log(`[LSTAT] No file found, invalid path "${path}" (fullPath="${fullPath}")`);
          return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        }
        
        // Get symlink stats
        const stats = await fspLStat(fullPath);
        const attrs: Attributes = {
          mode: stats.mode,
          uid: stats.uid,
          gid: stats.gid,
          size: stats.size,
          atime: stats.atimeMs,
          mtime: stats.mtimeMs
        };

        // Return attributes to client
        return sftp.attrs(reqId, attrs);
      } catch (err) {
        console.log(`[LSTAT] Error occurred`);
        console.error(err);
        return sftp.status(reqId, STATUS_CODE.FAILURE);
      }
    };
  };

}

class ConnectionController {

  constructor(protected sftpStream: SFTPStreamControlller) {}

  // Compares two values from buffers
  private checkValue(input: Buffer, allowed: Buffer) {
    // Auto-reject if lengths don't match
    if (input.length !== allowed.length) return false;
    return timingSafeEqual(input, allowed);
  }
  
  public onAuthentication = (ctx: AuthContext) => {
    console.log(`"${ctx.username}" wants to authenticate`)

    // If the username is not allowed
    const isUsernameMatching = this.checkValue(Buffer.from(ctx.username), allowedUser); 
    if (!isUsernameMatching) {
      console.warn(`User ${ctx.username} is not allowed. Rejecting connection.`)
      return ctx.reject();
    }

    switch (ctx.method) {
      case 'password': {
        console.log(`Auth method: password; Password="${ctx.password}"`);

        // Check password value
        const isPasswordMatching = this.checkValue(Buffer.from(ctx.password), allowedPassword);
        if (!isPasswordMatching) {
          console.warn(`Bad password for user ${ctx.username}. Rejecting connection.`)
          return ctx.reject();
        }
        break;
      }

      case 'none': {
        console.log(`Auth method: none`);
        return ctx.accept();
      }
      // case 'hostbased':
      // case 'keyboard-interactive':
      // case 'publickey':
      default: {
        console.warn(`Auth method "${ctx.method}" is not currently handled`)
        return ctx.reject()
      } 
    }

    // Accept connection
    return ctx.accept();
  };

  public onClose = () => {
    console.warn('Client disconnected');
  };

  public onError = (err) => {
    console.log('-----------------------')
    console.log('Error occurred');
    console.error(err);
    console.log('-----------------------')
  };

  public onSession = (accept: AcceptConnection<Session>, reject) => {
    const session = accept();

    session.on('sftp', (accept, reject) => {
      console.log('Client SFTP session');
      const sftp = accept(); // Accept the SFTP stream

      // OPEN - Triggered when the SFTP client attempts to open a file/directory
      sftp.on(SFTPEvent.OPEN, this.sftpStream.onOpen(sftp));

      // CLOSE - Triggered when the SFTP client closes a handle for a file/directory
      sftp.on(SFTPEvent.CLOSE, this.sftpStream.onClose(sftp));

      // READDIR - Triggered when the SFTP client asks for a directory listing
      sftp.on(SFTPEvent.READDIR, this.sftpStream.onReadDir(sftp));

      // REALPATH - Triggered when the SFTP client connects and wants to find out their "path" in the SFTP Server's file system; Also, it's triggered when the SFTP client has to resolve a (new) path in the server's file system (e.g. creating a new directory -- firstly, the client must check if the path of new dir is valid, via REALPATH)
      sftp.on(SFTPEvent.REALPATH, this.sftpStream.onRealPath(sftp));

      // OPENDIR - Triggered when a directory is opened in the SFTP client; this handler ensures that the dir's contents are read and stored for later, when the READDIR event is emitted
      sftp.on(SFTPEvent.OPENDIR, this.sftpStream.onOpenDir(sftp));

      // WRITE - Triggered when the SFTP client attempts writing content to a file
      sftp.on(SFTPEvent.WRITE, this.sftpStream.onWrite(sftp));

      // SETSTAT - Triggered when the SFTP client attempts to set/update the file metadata (permissions, ownership and/or timestamps)
      sftp.on(SFTPEvent.SETSTAT, this.sftpStream.onSetStat(sftp));

      // MKDIR - Triggered when SFTP client attempts to create a new directory on the SFTP server
      sftp.on(SFTPEvent.MKDIR, this.sftpStream.onMkDir(sftp));

      // RENAME - Triggered when the SFTP client attempts to rename a file/directory on the remote SFTP server
      sftp.on(SFTPEvent.RENAME, this.sftpStream.onRename(sftp));

      // REMOVE - Triggered when the SFTP client attempts to delete a file
      sftp.on(SFTPEvent.REMOVE, this.sftpStream.onRemove(sftp));

      // RMDIR - Triggered when the SFTP client attempts to delete a directory
      sftp.on(SFTPEvent.RMDIR, this.sftpStream.onRemove(sftp));
      
      // These 2 should be marked as "unsupported":
      // [Unsupported] SYMLINK - Triggered when the SFTP client attemps to create a symbolic link
      sftp.on(SFTPEvent.SYMLINK, this.sftpStream.onSymlink(sftp));

      // [Unsupported] READLINK - Triggered when the SFTP client attempts to read a symbolic link
      sftp.on(SFTPEvent.READLINK, this.sftpStream.onReadLink(sftp));

      // READ - Triggered when the SFTP client requests a chunk of data from a file (in order to copy a file FROM server to remote client?)
      sftp.on(SFTPEvent.READ, this.sftpStream.onRead(sftp));

      // STAT - Triggered when the SFTP client requests the attributes/metadata for a file/directory
      sftp.on(SFTPEvent.STAT, this.sftpStream.onStat(sftp));

      // FSTAT - Similar to STAT, but works with a FileHandle instead of path; Triggered when the SFTP client requests the attributes/metadata for a file/directory
      sftp.on(SFTPEvent.FSTAT, this.sftpStream.onFStat(sftp));
      
      // FSETSTAT - Similar to SETSTAT, but works with a FileHandle instead of a path; Triggered when the SFTP client attempts to set/update the file metadata (permissions, ownership and/or timestamps)
      sftp.on(SFTPEvent.FSETSTAT, this.sftpStream.onFSetStat(sftp));

      // LSTAT - Triggered when the SFTP client requests the attributes/metadata for a file/directory SYMLINK, not the file/dir itself
      sftp.on(SFTPEvent.LSTAT, this.sftpStream.onLStat(sftp));
    });
  }
}

export default (client: Connection, info: ClientInfo) => {
  console.log(`Client connected (IP: "${info.ip}"; Port: "${info.port}"; IdentRaw: "${info.header.identRaw}")`);
  
  const controller = new ConnectionController(
    new SFTPStreamControlller()
  );
  
  client.on('authentication', controller.onAuthentication);
  client.on('close', controller.onClose);
  client.on('error', controller.onError);

  client.on('ready', () => {
    console.log('Client authenticated');
    client.on('session', controller.onSession)
  });
}