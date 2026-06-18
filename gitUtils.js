const { exec } = require('child_process');
const path = require('path');
const os = require('os');

function expandHomeDir(dirPath) {
  if (dirPath.startsWith('~')) {
    return path.join(os.homedir(), dirPath.slice(1));
  }
  return dirPath;
}

function getRecentCommits(repoPath, limit = 10) {
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(expandHomeDir(repoPath || process.cwd()));

    const format = '%H|%h|%an|%ae|%ai|%s';
    const command = `git log --pretty=format:"${format}" -n ${limit}`;

    exec(command, { cwd: resolvedPath, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const errorMsg = stderr && stderr.trim() ? stderr.trim() : error.message;
        reject(new Error(`Git 命令执行失败: ${errorMsg}`));
        return;
      }

      const lines = stdout.trim().split('\n').filter(line => line.trim());

      const commits = lines.map(line => {
        const parts = line.split('|');
        return {
          hash: parts[0] || '',
          shortHash: parts[1] || '',
          author: parts[2] || '',
          email: parts[3] || '',
          date: parts[4] || '',
          message: parts.slice(5).join('|') || ''
        };
      });

      resolve({
        repoPath: resolvedPath,
        total: commits.length,
        commits
      });
    });
  });
}

module.exports = {
  getRecentCommits
};
