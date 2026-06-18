const { spawn, exec } = require('child_process');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const cache = new Map();
const CACHE_TTL = 30000;
const DEFAULT_TIMEOUT = 60000;

function expandHomeDir(dirPath) {
  if (dirPath.startsWith('~')) {
    return path.join(os.homedir(), dirPath.slice(1));
  }
  return dirPath;
}

function getCacheKey(repoPath, limit, skip) {
  const hash = crypto.createHash('md5');
  hash.update(`${repoPath}|${limit}|${skip}`);
  return hash.digest('hex');
}

function getCache(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, {
    data,
    timestamp: Date.now()
  });
}

function getTotalCommits(repoPath, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(expandHomeDir(repoPath || process.cwd()));
    const cacheKey = `total_${resolvedPath}`;

    const cached = getCache(cacheKey);
    if (cached !== null) {
      return resolve(cached);
    }

    const command = 'git rev-list --count HEAD';
    let timer = null;

    const child = exec(command, { cwd: resolvedPath, timeout }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) {
        const errorMsg = stderr && stderr.trim() ? stderr.trim() : error.message;
        reject(new Error(`Git 命令执行失败: ${errorMsg}`));
        return;
      }
      const total = parseInt(stdout.trim(), 10) || 0;
      setCache(cacheKey, total);
      resolve(total);
    });

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Git 命令执行超时'));
    }, timeout);
  });
}

function parseCommitLine(line) {
  const parts = line.split('|');
  return {
    hash: parts[0] || '',
    shortHash: parts[1] || '',
    author: parts[2] || '',
    email: parts[3] || '',
    date: parts[4] || '',
    message: parts.slice(5).join('|') || ''
  };
}

function getCommitsStream(repoPath, options = {}) {
  const {
    limit = 10,
    skip = 0,
    timeout = DEFAULT_TIMEOUT,
    onData,
    onEnd,
    onError
  } = options;

  const resolvedPath = path.resolve(expandHomeDir(repoPath || process.cwd()));
  const format = '%H|%h|%an|%ae|%ai|%s';
  const args = ['log', '--pretty=format:' + format];

  if (skip > 0) {
    args.push('--skip', String(skip));
  }
  if (limit > 0) {
    args.push('-n', String(limit));
  }

  const child = spawn('git', args, { cwd: resolvedPath });
  let buffer = '';
  let count = 0;
  let timer = null;

  timer = setTimeout(() => {
    child.kill('SIGTERM');
    if (onError) onError(new Error('Git 命令执行超时'));
  }, timeout);

  child.stdout.on('data', (data) => {
    buffer += data.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        const commit = parseCommitLine(line);
        count++;
        if (onData) onData(commit, count);
      }
    }
  });

  child.stderr.on('data', (data) => {
    const errorMsg = data.toString('utf8').trim();
    if (errorMsg && onError) {
      clearTimeout(timer);
      onError(new Error(`Git 命令执行失败: ${errorMsg}`));
      child.kill();
    }
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) {
      if (buffer.trim()) {
        const commit = parseCommitLine(buffer.trim());
        count++;
        if (onData) onData(commit, count);
      }
      if (onEnd) onEnd(count, resolvedPath);
    } else if (code !== null && onError) {
      onError(new Error(`Git 进程异常退出，代码: ${code}`));
    }
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    if (onError) onError(err);
  });

  return child;
}

function getRecentCommits(repoPath, limit = 10, skip = 0, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(expandHomeDir(repoPath || process.cwd()));
    const cacheKey = getCacheKey(resolvedPath, limit, skip);

    const cached = getCache(cacheKey);
    if (cached !== null) {
      return resolve(cached);
    }

    const commits = [];

    getCommitsStream(repoPath, {
      limit,
      skip,
      timeout,
      onData: (commit) => {
        commits.push(commit);
      },
      onEnd: (total, path) => {
        const result = {
          repoPath: path,
          total,
          commits
        };
        setCache(cacheKey, result);
        resolve(result);
      },
      onError: (err) => {
        reject(err);
      }
    });
  });
}

function getCommitsWithPagination(repoPath, page = 1, pageSize = 10) {
  const skip = (page - 1) * pageSize;
  return Promise.all([
    getTotalCommits(repoPath),
    getRecentCommits(repoPath, pageSize, skip)
  ]).then(([totalCount, result]) => ({
    ...result,
    totalCount,
    page,
    pageSize,
    totalPages: Math.ceil(totalCount / pageSize) || 0
  }));
}

function clearCache() {
  cache.clear();
}

module.exports = {
  getRecentCommits,
  getCommitsStream,
  getCommitsWithPagination,
  getTotalCommits,
  clearCache
};
