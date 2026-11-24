const fileReaders = /\b(?:readFile(?:Sync)?|readdir(?:Sync)?|existsSync|createReadStream|sendFile|static)\b/;
// `'./data/static/codefixes/' + key` names a folder whose files are read by a computed name.
const folderPrefix = /['"`](?:\.\/)?((?:[\w.-]+\/){2,})['"`]/g;
// `express.static('public')` and `static(path.join(__dirname, '..', 'public'))` serve a whole
// folder; the `..` steps are dropped because folders match by name anywhere in the project.
const staticFolder =
  /\bstatic\(\s*(?:path\.(?:join|resolve)\(\s*)?(?:__dirname\s*,\s*|process\.cwd\(\)\s*,\s*)?(?:['"]\.\.?['"]\s*,\s*)*['"]([\w./-]+)['"]/g;

// Folders that a source file reads from or serves at runtime, so their files need no import.
function runtimeDirectories(text: string): Set<string> {
  const directories = new Set<string>();
  if (!fileReaders.test(text)) return directories;
  const folders = [...text.matchAll(folderPrefix), ...text.matchAll(staticFolder)].map(([, folder]) =>
    folder.replace(/^\.\//, '').replace(/\/$/, ''),
  );
  // A bare `.` or `..` would claim every file in the project.
  for (const folder of folders) if (/^[\w-][\w./-]*$/.test(folder)) directories.add(folder);
  return directories;
}

function isInside(file: string, directory: string): boolean {
  return file.startsWith(directory + '/') || file.includes('/' + directory + '/');
}

export { runtimeDirectories, isInside };
