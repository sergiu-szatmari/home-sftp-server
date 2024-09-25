import { AcceptConnection, AuthContext, Connection, FileEntry, RejectConnection, Server, ServerConfig, Session } from 'ssh2';
import { timingSafeEqual } from 'crypto'
import {
  readFileSync as fsReadFileSync,
  existsSync as fsExistsSync,
  createWriteStream as fsCreateWriteStream,
  stat as fsStat,
  readdir as fsReaddir
} from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { utils } from 'ssh2'

// ----- Config ----- //
const PORT = 8022;
const hostPrivateKeyFilePath = path.join(__dirname, '../id_rsa');

// Parent directory of "data"
const dataParentDirPath = path.join(__dirname, '..');

// The "root" directory for SFTP clients (/data); Everything below is visible to SFTP clients
const dataDirPath = path.join(__dirname, '../data');
// ------------------ //

// ------ Aux ------ //
type FileHandle = number;
type FileData = {
  path: string; // Path for file or directory
  fullPath: string; // TODO: Absolute path related to system's file system
  
  isDirectory: boolean;
  files: string[]; // Is relevant only if "this.isDirectory"
  offset: number; // Is relevant only if "this.isDirectory"
  // ...
}
enum SFTPEvent {
  READ = 'READ',
  WRITE = 'WRITE',
  FSTAT = 'FSTAT',
  FSETSTAT = 'FSETSTAT',
  OPENDIR = 'OPENDIR',
  LSTAT = 'LSTAT',
  STAT = 'STAT',
  REMOVE = 'REMOVE',
  RMDIR = 'RMDIR',
  READLINK = 'READLINK',
  SETSTAT = 'SETSTAT',
  MKDIR = 'MKDIR',
  RENAME = 'RENAME',
  SYMLINK = 'SYMLINK',
  EXTENDED = 'EXTENDED',
  OPEN = 'OPEN',
  CLOSE = 'CLOSE',
  READDIR = 'READDIR',
  REALPATH = 'REALPATH',
}
// ----------------- //

// Map for keeping data for each opened file/directory (indexed by fileHandle)
const openFiles = new Map<FileHandle, FileData>();

// A counter for generating unique handle IDs
let handleCount = 0;

const debug = () => {
  const entries: string[] = [];
  openFiles.forEach((val, key) => entries.push(`#${key} -> ${JSON.stringify(val)}`));
  console.log([
    '------- Open Files Handlers -------',
    ...entries,
    '-----------------------------------',
    '',
    ''
  ].join('\n'))
}

function checkValue(input: Buffer, allowed: Buffer) {
  // Auto-reject if lengths don't match
  if (input.length !== allowed.length) return false;

  return timingSafeEqual(input, allowed);
}

const sftpConfig: ServerConfig = {
  hostKeys: [
    fsReadFileSync(hostPrivateKeyFilePath)
  ]
}

const allowedUser = Buffer.from('sergiu');
const allowedPassword = Buffer.from('password');

const server = new Server(sftpConfig, (client: Connection) => {
  console.log('Client connected');

  client.on('authentication', (ctx: AuthContext) => {
    console.log(`"${ctx.username}" wants to authenticate`)

    // If the username is not allowed
    if (!checkValue(Buffer.from(ctx.username), allowedUser)) {
      console.warn(`User ${ctx.username} is not allowed. Rejecting connection.`)
      return ctx.reject();
    }

    switch (ctx.method) {
      case 'password': {
        console.log(`Auth method: password; Password="${ctx.password}"`);

        // Check password value
        if (!checkValue(Buffer.from(ctx.password), allowedPassword)) {
          console.warn(`Bad password for user ${ctx.username}. Rejecting connection.`)
          return ctx.reject();
        }
        break;
      }

      case 'none': {
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
  });

  client.on('close', () => {
    console.warn('Client disconnected');
  });

  client.on('error', (err) => {
    console.log('-----------------------')
    console.log('Error occurred');
    console.error(err);
    console.log('-----------------------')
  })

  client.on('ready', () => {
    console.log('Client authenticated!');

    client.on('session', (accept: AcceptConnection<Session>, reject: RejectConnection) => {
      const session = accept();
      
      session.on('sftp', (accept, reject) => {
        console.log('Client SFTP session');
        const sftp = accept(); // Accept the SFTP stream
        
        // Handling for OPEN (triggered when the SFTP client attempts to open a file/directory)
        sftp.on(SFTPEvent.OPEN, (reqId, filename, flags, attrs) => {
          
          // Convert bitwise flags to string (e.g. 58 -> "wx")
          const stringFlags = utils.sftp.flagsToString(flags);
          if (!stringFlags) {
            console.log(`[OPEN] Error converting flags to string (flags: "${flags}")`);
            return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
          }

          // Compute the "full path" (of file, as it is found in the system) from the "relative" path to 
          const fullFilePath = path.join(dataParentDirPath, filename);
          console.log(`[OPEN] reqId=${reqId}; filename=${filename}; fullFilePath=${fullFilePath}; flags=${flags} ("${stringFlags}"); attrs=${JSON.stringify(attrs)}`);

          // Create a handleId from buffer so it can be used later
          const handle = Buffer.alloc(4);

          // Check if file exists (for later use)
          const fileExists = fsExistsSync(fullFilePath);

          // If opening mode is READ
          if (stringFlags.includes('r')) {
            if (!fileExists) {
              // ...and fail the request if it doesn't exist
              console.log(`[OPEN] Error: file not found (path: "${fullFilePath}")`);
              return sftp.status(reqId, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
            }

            // File exists, so get file stats and handle accordingly
            fsStat(fullFilePath, (err, stat) => {
              if (err) {
                // Handle error
                console.warn(`[OPEN] Error getting stats for file "${filename}" (full: "${fullFilePath}")`);
                console.error(err);
                return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
              }

              const isDirectory = stat.isDirectory();

              // Set entry in opened files Map
              openFiles.set(handleCount, {
                path: filename,
                fullPath: fullFilePath,
                isDirectory, files: [], offset: 0,
              });

              // Write handler and increment counter for next usage
              handle.writeUInt32BE(handleCount, 0);
              handleCount++;

              console.log(`[OPEN] ${isDirectory ? 'Directory' : 'File'} opened "${filename}" (full path: "${fullFilePath}")`);
              debug()

              return sftp.handle(reqId, handle)
            });
          } else if (stringFlags.includes('w')) {
            // If opening mode is WRITE
            
            const writeStream = fsCreateWriteStream(fullFilePath, { mode: 0o755, /*flags: stringFlags,*/ encoding: 'utf8' });

            // Handle error event
            writeStream.on('error', (err) => {
              console.warn(`[OPEN] Error creating file "${filename}" (full: "${fullFilePath}")`);
              console.error(err);
              return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
            });

            // Write empty string to newly created file
            writeStream.write('');
            writeStream.end(() => {
              // After the stream closes, get file stats and pass those to sftp client
              fsStat(fullFilePath, (err, stat) => {
                if (err) {
                  // Handle error
                  console.warn(`[OPEN] Error getting stats for file "${filename}" (full: "${fullFilePath}")`);
                  console.error(err);
                  return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
                }
                
                const isDirectory = stat.isDirectory();
  
                // Set entry in opened files Map
                openFiles.set(handleCount, {
                  path: filename,
                  fullPath: fullFilePath,
                  isDirectory, files: [], offset: 0,
                });
  
                // Write handler and increment counter for next usage
                handle.writeUInt32BE(handleCount, 0);
                handleCount++;
  
                console.log(`[OPEN] ${isDirectory ? 'Directory' : 'File'} opened "${filename}" (full path: "${fullFilePath}")`);
                debug()
  
                return sftp.handle(reqId, handle)
              })
            });
          } else {
            // Handle invalid/unsupported request
            console.log(`[OPEN] Invalid/unsupported request "${filename}" (fullPath: "${fullFilePath}"; flags: "${flags}")`);
            return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
          }
        });

        // Handling for CLOSE (triggered when the SFTP client closes a file/directory)
        sftp.on(SFTPEvent.CLOSE, (reqId, handle) => {
          // Read/extract the HandleId from the buffer
          const handleId = handle.readUInt32BE(0);
          const openFileEntry = openFiles.get(handleId);

          if (!openFileEntry) {
            console.log(`[CLOSE] No entry found in OpenFiles map. reqId=${reqId}; handleId=${handleId}`);
            return sftp.status(reqId, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
            // return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
          }

          console.log(`[CLOSE] Closing file/dir handler; reqId=${reqId}; path=${openFileEntry.path}; isDirectory=${openFileEntry.isDirectory}; handleId=${handleId}`);
          
          // Remove handler from Handler Map
          openFiles.delete(handleId);
          debug();

          // Return status to SFTP client
          return sftp.status(reqId, utils.sftp.STATUS_CODE.OK);
        });

        // Handling for READDIR (triggered when the SFTP client asks for a directory listing)
        sftp.on(SFTPEvent.READDIR, (reqId, handle) => {
          // Read/extract the HandleId from the buffer
          const handleId = handle.readUInt32BE(0);
          const openFileEntry = openFiles.get(handleId);
          
          if (!openFileEntry || !openFileEntry.isDirectory) {
            console.log(`[READDIR] Invalid directory handle; reqId=${reqId}, handleId=${handleId}, path=${openFileEntry?.path}`);
            return sftp.status(reqId, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
            // return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
          }

          // Check if directory wasn't listed before (to prevent an infinite READDIR emit)
          const { files, offset } = openFileEntry;
          
          // If no more files to send
          if (offset >= files.length) {
            console.log(`[READDIR] End of listing (from before)`);
            return sftp.status(reqId, utils.sftp.STATUS_CODE.EOF);
          }

          const batchSize = 10;
          const entries = files.slice(offset, offset + batchSize).map((file): FileEntry => ({
            filename: file,
            longname: file,
            attrs: {
              // TODO
              mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0
            }
          }))
          console.log(`[READDIR] Listing directory "${openFileEntry.path}": [${entries.map(e => e.filename).join(',')}]`)

          // Update offset for the next READDIR handler
          openFileEntry.offset += entries.length;

          // Send files
          return sftp.name(reqId, entries);
          
          // // If entry exists and is directory, read the contents of directory
          // fs.readdir(openFileEntry.fullPath /*openFileEntry.path*/, (err, files) => {
          //   if (err) {
          //     // Error handling if readdir fails
          //     console.log(`[READDIR] Error reading directory reqId=${reqId}, path=${openFileEntry.path}, handleId=${handleId}`)
          //     return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
          //   }

          //   // Check if directory listing is complete and signal this to the SFTP client
          //   if (files.length === 0) {
          //     console.log(`[READDIR] No more files in directory "${openFileEntry.path}" (sys/full path: "${openFileEntry.fullPath}")`)
          //     // sftp.name(reqId, []);
          //     return sftp.status(reqId, utils.sftp.STATUS_CODE.EOF); // Important --> This signals end of directory; Prevents SFTP client from continuosly requesting READDIR
          //   }

          //   // Map directory entries to the format required by SFTP clients
          //   const entries = files.map((file): FileEntry => ({
          //     filename: file,
          //     longname: file,
          //     attrs: {
          //       // TODO
          //       mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0
          //     }
          //   }));
          //   console.log(`[READDIR] Listing directory "${openFileEntry.path}": [${files.join(',')}]`)

          //   // Send files to SFTP client
          //   sftp.name(reqId, entries);

          //   // Signal the end of directory listing to prevent the client from emitting more READDIR events
          //   return sftp.status(reqId, utils.sftp.STATUS_CODE.EOF);
          // })
        });

        // Handling for REALPATH (triggered when the SFTP client connects and wants to find out their "path" in the SFTP Server's file system)
        sftp.on(SFTPEvent.REALPATH, (reqId, requestedPath) => {
          console.log(`[REALPATH] reqId=${reqId}, requestedPath=${requestedPath}`);

          requestedPath = path.normalize(requestedPath)
          console.log(`[REALPATH] Normalized path=${requestedPath}`);

          return sftp.name(reqId, [{ filename: '/data', longname: '/data', attrs: { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }}])
        });

        // Handling for OPENDIR (triggered when a directory is opened in the SFTP client; this handler ensures that the dir's contents are read and stored for later, when the READDIR event is emitted)
        sftp.on(SFTPEvent.OPENDIR, (reqId, dirPath) => {
          console.log(`[OPENDIR] reqId=${reqId}, dirPath=${dirPath}`);

          // Normalization
          dirPath = path.normalize(dirPath);

          const fullDirPath = path.join(dataParentDirPath, dirPath);

          fsStat(fullDirPath, (err, stats) => {
            if (err) {
              // Error handling
              console.log(`[OPENDIR] Error occurred for "${dirPath}" (${fullDirPath})`);
              console.error(err);
              return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
            }
            
            if (!stats.isDirectory()) {
              console.error(`[OPENDIR] Path "${dirPath}" is not a directory`);
              return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
            }

            fsReaddir(fullDirPath, (err1, files) => {
              if (err1) {
                // Error handling if readdir fails
                console.log(`[READDIR] Error reading directory reqId=${reqId}, path=${dirPath}, handleId=none,yet`)
                return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
              }

              // Create & assign handle for directory
              const handle = Buffer.alloc(4);
              openFiles.set(handleCount, { 
                path: dirPath,
                fullPath: fullDirPath,
                
                isDirectory: true,
                files,
                offset: 0,
              })
              handle.writeUInt32BE(handleCount, 0);
              handleCount++;
  
              console.log(`[OPENDIR] Directory opened "${dirPath}"`)
              debug();
  
              return sftp.handle(reqId, handle);
            });
          })
        });

        // Handling for WRITE (triggered when the SFTP client attempts writing content to a file)
        sftp.on(SFTPEvent.WRITE, async (reqId, handle, offset, data) => {
          const handleId = handle.readUInt32BE(0);
          const openFileEntry = openFiles.get(handleId);
          console.log(`[WRITE] reqId=${reqId}; handleId=${handleId}; offset=${offset}; data.length=${data.length}`)

          if (!openFileEntry) {
            console.log(`[WRITE] No entry found for handle "${handleId}"`);
            return sftp.status(reqId, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
          }

          try {
            const stream = fsCreateWriteStream(openFileEntry.fullPath, {
              encoding: 'utf8',
              start: offset,
              flags: 'w',
              mode: 0o755,
            });
            stream.write(data);
            stream.end();
            // await fs.writeFile(openFileEntry.fullPath, data, { encoding: 'utf8' });
            console.log(`[WRITE] Successfully written file "${openFileEntry.fullPath}"`);

            return sftp.status(reqId, utils.sftp.STATUS_CODE.OK);
          } catch(err) {
            console.log(`[WRITE] Error occurred while writing to file "${openFileEntry.fullPath}" (reqId=${reqId}, handleId=${handleId})`)
            console.error(err);
            return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
          }
        });

        // Handling for SETSTAT (triggered after an SFTP client creates/updates a file and attempts to set/update the permissions and/or timestamps)
        sftp.on(SFTPEvent.SETSTAT, async (reqId, filePath, attrs) => {
          console.log(`[SETSTAT] reqId=${reqId}; filePath=${filePath}; attrs=${JSON.stringify(attrs)}`);
          
          try {
            // Path normalization
            filePath = path.normalize(filePath);
            console.log(`[SETSTAT] normalizedPath=${filePath}`);
            
            const fullPath = path.join(dataParentDirPath, filePath);
            
            // Check if file exists and get current stats
            const stats = await fs.stat(fullPath);
            
            // const { mode, uid, gid, atime, mtime } = attrs;
            const mode = attrs.mode || stats.mode;
            const uid = attrs.uid || stats.uid;
            const gid = attrs.gid || stats.gid;
            const atime = attrs.atime || stats.atime;
            const mtime = attrs.mtime || stats.mtime;
            
            // Update permissions (if requested)
            await fs.chmod(fullPath, mode);

            // Update ownership (if requested)
            await fs.chown(fullPath, uid, gid);

            // Update timestamps (if requested)
            await fs.utimes(fullPath, atime, mtime)

            // Send success response to SFTP client
            return sftp.status(reqId, utils.sftp.STATUS_CODE.OK);
          } catch (err) {
            console.log(`[SETSTAT] Error occurred; reqId=${reqId}; filePath=${filePath}; attrs=${JSON.stringify(attrs)}`);
            console.error(err);
            return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
          }
        });

        // sftp.on(SFTPEvent.MKDIR, ......)
        // sftp.on(SFTPEvent.RENAME, ......)
      });
    });
  });
})

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  if (!address) {
    console.log(`SFTP Server is not listening...`);
  } else if (typeof address === 'string') {
    console.log(`SFTP Server is listening (${address})`)
  } else {
    console.log(`SFTP Server listening on port ${address.port}`)
  }
})