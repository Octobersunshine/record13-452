const express = require('express');
const { getRecentCommits } = require('./gitUtils');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'Git Commit API',
    version: '1.0.0',
    endpoints: {
      'GET /api/commits': '获取当前工作目录的最近提交记录',
      'GET /api/commits?path=仓库路径&limit=数量': '获取指定仓库的最近提交记录'
    }
  });
});

app.get('/api/commits', async (req, res) => {
  try {
    const { path, limit } = req.query;
    const parsedLimit = limit ? parseInt(limit, 10) : 10;

    if (parsedLimit < 1 || parsedLimit > 100 || isNaN(parsedLimit)) {
      return res.status(400).json({
        success: false,
        error: 'limit 参数必须是 1 到 100 之间的整数'
      });
    }

    const result = await getRecentCommits(path, parsedLimit);

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

app.listen(PORT, () => {
  console.log(`Git Commit API 服务已启动: http://localhost:${PORT}`);
  console.log(`接口地址: http://localhost:${PORT}/api/commits`);
});
