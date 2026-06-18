const express = require('express');
const {
  getRecentCommits,
  getCommitsStream,
  getCommitsWithPagination,
  getTotalCommits,
  clearCache
} = require('./gitUtils');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/', (req, res) => {
  res.json({
    name: 'Git Commit API',
    version: '2.0.0',
    description: '优化版本：支持分页、流式输出、缓存和超时控制',
    endpoints: {
      'GET /api/commits': '获取提交记录（支持 limit, skip, path 参数）',
      'GET /api/commits/page': '分页获取提交记录（支持 page, pageSize, path 参数）',
      'GET /api/commits/stream': 'SSE 流式获取提交记录（支持 limit, skip, path 参数）',
      'GET /api/commits/total': '获取仓库总提交数',
      'POST /api/cache/clear': '清除缓存'
    }
  });
});

app.get('/api/commits', async (req, res) => {
  try {
    const { path, limit, skip } = req.query;
    const parsedLimit = limit ? parseInt(limit, 10) : 10;
    const parsedSkip = skip ? parseInt(skip, 10) : 0;

    if (parsedLimit < 1 || parsedLimit > 500 || isNaN(parsedLimit)) {
      return res.status(400).json({
        success: false,
        error: 'limit 参数必须是 1 到 500 之间的整数'
      });
    }

    if (parsedSkip < 0 || isNaN(parsedSkip)) {
      return res.status(400).json({
        success: false,
        error: 'skip 参数必须是非负整数'
      });
    }

    const result = await getRecentCommits(path, parsedLimit, parsedSkip);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/commits/page', async (req, res) => {
  try {
    const { path, page, pageSize } = req.query;
    const parsedPage = page ? parseInt(page, 10) : 1;
    const parsedPageSize = pageSize ? parseInt(pageSize, 10) : 10;

    if (parsedPage < 1 || isNaN(parsedPage)) {
      return res.status(400).json({
        success: false,
        error: 'page 参数必须是大于等于 1 的整数'
      });
    }

    if (parsedPageSize < 1 || parsedPageSize > 200 || isNaN(parsedPageSize)) {
      return res.status(400).json({
        success: false,
        error: 'pageSize 参数必须是 1 到 200 之间的整数'
      });
    }

    const result = await getCommitsWithPagination(path, parsedPage, parsedPageSize);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/commits/stream', (req, res) => {
  try {
    const { path, limit, skip } = req.query;
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const parsedSkip = skip ? parseInt(skip, 10) : 0;

    if (parsedLimit < 1 || parsedLimit > 1000 || isNaN(parsedLimit)) {
      return res.status(400).json({
        success: false,
        error: 'limit 参数必须是 1 到 1000 之间的整数'
      });
    }

    if (parsedSkip < 0 || isNaN(parsedSkip)) {
      return res.status(400).json({
        success: false,
        error: 'skip 参数必须是非负整数'
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.write(`event: metadata\ndata: ${JSON.stringify({
      status: 'start',
      limit: parsedLimit,
      skip: parsedSkip,
      timestamp: Date.now()
    })}\n\n`);

    let commitCount = 0;

    const child = getCommitsStream(path, {
      limit: parsedLimit,
      skip: parsedSkip,
      timeout: 120000,
      onData: (commit, index) => {
        commitCount++;
        res.write(`event: commit\ndata: ${JSON.stringify({ index, commit })}\n\n`);
      },
      onEnd: (total, repoPath) => {
        res.write(`event: complete\ndata: ${JSON.stringify({
          status: 'complete',
          total,
          repoPath,
          commitCount
        })}\n\n`);
        res.end();
      },
      onError: (err) => {
        res.write(`event: error\ndata: ${JSON.stringify({
          status: 'error',
          error: err.message
        })}\n\n`);
        res.end();
      }
    });

    req.on('close', () => {
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      res.end();
    });

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

app.get('/api/commits/total', async (req, res) => {
  try {
    const { path } = req.query;
    const total = await getTotalCommits(path);

    res.json({
      success: true,
      data: {
        repoPath: path || process.cwd(),
        totalCommits: total
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/cache/clear', (req, res) => {
  try {
    clearCache();
    res.json({
      success: true,
      message: '缓存已清除'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log('  Git Commit API v2.0.0');
  console.log('========================================');
  console.log(`服务已启动: http://localhost:${PORT}`);
  console.log('');
  console.log('接口列表:');
  console.log('  GET  /api/commits           - 获取提交记录');
  console.log('  GET  /api/commits/page      - 分页获取');
  console.log('  GET  /api/commits/stream    - SSE 流式输出');
  console.log('  GET  /api/commits/total     - 获取总提交数');
  console.log('  POST /api/cache/clear       - 清除缓存');
  console.log('========================================');
});
