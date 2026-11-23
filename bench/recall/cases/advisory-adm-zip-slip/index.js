// Pre-fix zip extraction shape (Snyk Zip Slip, CVE-2018-1002204 adm-zip): entry names are joined onto the destination without containment checks.
const fs = require('node:fs');
const path = require('node:path');
const unzipper = require('unzipper');

module.exports = function extract(archivePath, destination) {
  fs.createReadStream(archivePath)
    .pipe(unzipper.Parse())
    .on('entry', (entry) => {
      entry.pipe(fs.createWriteStream(path.join(destination, entry.path)));
    });
};
