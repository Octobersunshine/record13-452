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

function getCacheKey(repoPath, limit, skip, author) {
  const hash = crypto.createHash('md5');
  hash.update(`${repoPath}|${limit}|${skip}|${author || ''}`);
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

function getTotalCommits(repoPath, options = {}) {
  return new Promise((resolve, reject) => {
    const { author, timeout = DEFAULT_TIMEOUT } = options;
    const resolvedPath = path.resolve(expandHomeDir(repoPath || process.cwd()));
    const cacheKey = `total_${resolvedPath}_${author || ''}`;

    const cached = getCache(cacheKey);
    if (cached !== null) {
      return resolve(cached);
    }

    const args = ['rev-list', '--count', 'HEAD'];
    if (author) {
      args.push('--author', author);
    }

    let timer = null;

    const child = spawn('git', args, { cwd: resolvedPath });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const total = parseInt(stdout.trim(), 10) || 0;
        setCache(cacheKey, total);
        resolve(total);
      } else {
        const errorMsg = stderr.trim() || `Git 进程退出代码: ${code}`;
        reject(new Error(`Git 命令执行失败: ${errorMsg}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
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
    author = null,
    onData,
    onEnd,
    onError
  } = options;

  const resolvedPath = path.resolve(expandHomeDir(repoPath || process.cwd()));
  const format = '%H|%h|%an|%ae|%ai|%s';
  const args = ['log', '--pretty=format:' + format];

  if (author) {
    args.push('--author', author);
  }
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
  let errorOccurred = false;

  timer = setTimeout(() => {
    child.kill('SIGTERM');
    errorOccurred = true;
    if (onError) onError(new Error('Git 命令执行超时'));
  }, timeout);

  child.stdout.on('data', (data) => {
    if (errorOccurred) return;
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
    if (errorOccurred) return;
    const errorMsg = data.toString('utf8').trim();
    if (errorMsg) {
      errorOccurred = true;
      clearTimeout(timer);
      if (onError) onError(new Error(`Git 命令执行失败: ${errorMsg}`));
      child.kill();
    }
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (errorOccurred) return;
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
    if (errorOccurred) return;
    errorOccurred = true;
    clearTimeout(timer);
    if (onError) onError(err);
  });

  return child;
}

function getRecentCommits(repoPath, limit = 10, skip = 0, options = {}) {
  return new Promise((resolve, reject) => {
    const { author, timeout = DEFAULT_TIMEOUT } = options;
    const resolvedPath = path.resolve(expandHomeDir(repoPath || process.cwd()));
    const cacheKey = getCacheKey(resolvedPath, limit, skip, author);

    const cached = getCache(cacheKey);
    if (cached !== null) {
      return resolve(cached);
    }

    const commits = [];

    getCommitsStream(repoPath, {
      limit,
      skip,
      author,
      timeout,
      onData: (commit) => {
        commits.push(commit);
      },
      onEnd: (total, path) => {
        const result = {
          repoPath: path,
          authorFilter: author || null,
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

function getCommitsWithPagination(repoPath, page = 1, pageSize = 10, options = {}) {
  const skip = (page - 1) * pageSize;
  const { author } = options;
  return Promise.all([
    getTotalCommits(repoPath, { author }),
    getRecentCommits(repoPath, pageSize, skip, { author })
  ]).then(([totalCount, result]) => ({
    ...result,
    totalCount,
    page,
    pageSize,
    totalPages: Math.ceil(totalCount / pageSize) || 0
  }));
}

function getAuthors(repoPath, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(expandHomeDir(repoPath || process.cwd()));
    const cacheKey = `authors_${resolvedPath}`;

    const cached = getCache(cacheKey);
    if (cached !== null) {
      return resolve(cached);
    }

    const args = ['log', '--pretty=format:%an|%ae'];
    const child = spawn('git', args, { cwd: resolvedPath });

    let stdout = '';
    let stderr = '';
    let timer = null;

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const authorMap = new Map();
        const lines = stdout.trim().split('\n').filter(line => line.trim());

        for (const line of lines) {
          const [name, email] = line.split('|');
          if (!authorMap.has(name)) {
            authorMap.set(name, {
              name: name || '',
              email: email || '',
              commits: 0
            });
          }
          authorMap.get(name).commits++;
        }

        const authors = Array.from(authorMap.values()).sort((a, b) => b.commits - a.commits);

        setCache(cacheKey, {
          repoPath: resolvedPath,
          total: authors.length,
          authors
        });

        resolve({
          repoPath: resolvedPath,
          total: authors.length,
          authors
        });
      } else {
        const errorMsg = stderr.trim() || `Git 进程退出代码: ${code}`;
        reject(new Error(`Git 命令执行失败: ${errorMsg}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Git 命令执行超时'));
    }, timeout);
  });
}

function clearCache() {
  cache.clear();
}

module.exports = {
  getRecentCommits,
  getCommitsStream,
  getCommitsWithPagination,
  getTotalCommits,
  getAuthors,
  clearCache
};
