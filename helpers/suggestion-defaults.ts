/**
 * 建议种子数据 / Suggestion seed data
 *
 * 主页"试试这些任务/问题"的默认建议数据,作为后端 GET /api/suggestions 的基础。
 * 用户的使用历史叠加在这之上(history → "最近使用"分类),前端不再硬编码这份数据。
 */

export type SuggestionItem = {
  title: string;
  text: string;
};

export type SuggestionCategory = {
  id: string;
  label: string;
  items: SuggestionItem[];
};

export type SuggestionDefaults = {
  chat: SuggestionItem[];
  agent: SuggestionCategory[];
};

export type SuggestionLocale = 'zh' | 'en';

export const SUGGESTION_DEFAULTS: SuggestionDefaults = {
  chat: [
    { title: '解释概念', text: '解释一下量子计算的基本原理' },
    { title: '写代码', text: '用 Python 写一个快速排序算法' },
    { title: '写邮件', text: '帮我写一封请假邮件,事由是家中有急事' },
    { title: '技术对比', text: '对比 React 和 Vue 的优缺点' },
  ],
  agent: [
    {
      id: 'life',
      label: '生活查询',
      items: [
        { title: '搜索天气', text: '打开浏览器搜索今天的天气' },
        { title: '查天气预报', text: '打开浏览器搜索北京未来三天的天气预报' },
        { title: '查汇率', text: '打开浏览器查询今日美元兑人民币汇率' },
        { title: '查股价', text: '打开浏览器搜索苹果公司最新股价' },
        { title: '查油价', text: '打开浏览器查询今日 92 号汽油价格' },
        { title: '查空气质量', text: '打开浏览器搜索北京今天的空气质量指数' },
        { title: '查菜谱', text: '搜索番茄炒蛋的做法,列出食材和步骤' },
        { title: '查航班', text: '搜索明天北京到上海的航班信息' },
        { title: '查火车票', text: '搜索明天北京到上海的高铁票信息' },
        { title: '查旅游', text: '搜索杭州必去的十大景点及门票价格' },
        { title: '查电影', text: '搜索本周正在热映的电影列表' },
        { title: '查图书', text: '搜索《三体》的豆瓣评分和简介' },
        { title: '查音乐', text: '搜索本周华语新歌榜热门歌曲' },
        { title: '查星座', text: '搜索今日白羊座运势' },
        { title: '查健身', text: '搜索适合初学者的家庭健身计划' },
        { title: '查养生', text: '搜索春季养生饮食注意事项' },
        { title: '查驾考新规', text: '搜索最新驾照考试规定的变化' },
        { title: '查房价', text: '搜索北京朝阳区最新二手房均价' },
        { title: '查租房', text: '搜索北京海淀区一居室租房价格' },
        { title: '查公积金', text: '搜索北京住房公积金最新政策' },
        { title: '查社保', text: '搜索最新社保缴费基数标准' },
        { title: '查医保', text: '搜索北京医保报销比例最新标准' },
        { title: '查个税', text: '搜索最新个人所得税计算方法' },
        { title: '查信用卡', text: '搜索招商银行信用卡最新优惠活动' },
        { title: '查疫情', text: '搜索最新的流感疫情数据' },
        { title: '查节假日', text: '搜索今年法定节假日放假安排' },
      ],
    },
    {
      id: 'work',
      label: '工作办公',
      items: [
        { title: '网页摘要', text: '抓取 https://finance.sina.com.cn 的内容并总结经济新闻要点' },
        { title: '搜索新闻', text: '搜索最新的 AI 技术新闻,汇总前 5 条' },
        { title: '读取文档', text: '读取 README.md 并总结内容' },
        { title: '翻译文档', text: '读取 README.md 并翻译为英文' },
        { title: '生成报告', text: '读取 package.json 并生成项目依赖报告' },
        { title: '查论文', text: '搜索最近关于大语言模型的论文,列出标题和摘要' },
        { title: '查招聘', text: '搜索前端工程师最新招聘岗位要求' },
        { title: '查面试题', text: '搜索大厂前端面试高频题目 TOP 10' },
        { title: '查英语', text: '搜索商务英语常用邮件模板' },
        { title: '查PPT模板', text: '搜索免费PPT模板下载网站推荐' },
      ],
    },
    {
      id: 'dev',
      label: '开发辅助',
      items: [
        { title: '分析代码', text: '搜索项目中所有的 TODO 注释并列出来' },
        { title: '执行脚本', text: '运行 node -e "console.log(process.version)" 查看当前 Node 版本' },
        { title: '查TODO', text: '搜索所有源代码文件中的 TODO 和 FIXME 注释' },
        { title: '查console.log', text: '搜索前端代码中所有 console.log 调用' },
        { title: '查项目结构', text: '从项目结构和依赖关系上分析一下这个仓库的主要模块' },
        { title: '查代码行数', text: '统计项目中各类型文件的代码行数' },
        { title: '查Git状态', text: '查看当前项目 Git 状态和最近提交' },
        { title: '查依赖版本', text: '检查 package.json 中依赖的最新版本' },
        { title: '查安全漏洞', text: '运行 npm audit 检查项目依赖的安全问题' },
        { title: '查NPM包', text: '搜索 lodash 的 NPM 下载量和版本信息' },
        { title: '查开源项目', text: '搜索 GitHub 上最热门的 AI 项目' },
        { title: '查API文档', text: '打开浏览器搜索 OpenAI API 最新文档' },
        { title: '查Docker', text: '列出当前运行的 Docker 容器和镜像' },
        { title: '查Regex', text: '帮我写一个匹配邮箱地址的正则表达式并测试' },
        { title: '查Cron', text: '帮我写一个每天早上9点执行的 Cron 表达式' },
        { title: '查SQL', text: '写一个 SQL 查询:按销售额降序取前10名客户' },
        { title: '查IDE报错', text: '帮我看看这个项目在 IDEA 里哪些文件有报错或 warning' },
        { title: '查运行配置', text: '看看这个项目在 IDEA 里有哪些运行配置,哪个最适合本地启动' },
        { title: '查编辑上下文', text: '看看 IDEA 当前打开了哪些文件,并判断我现在最可能在处理什么问题' },
        { title: '查符号影响', text: '按 IDE 的理解帮我判断这个类改名会影响哪些地方' },
        { title: '查重构方案', text: '这个改动涉及引用关系,尽量按更安全的重构方式处理' },
      ],
    },
    {
      id: 'sys',
      label: '系统操作',
      items: [
        { title: '查看文件', text: '查看当前目录的文件结构' },
        { title: '屏幕截图', text: '截取当前屏幕截图' },
        { title: '整理文件', text: '列出当前目录下所有 .log 文件并统计大小' },
        { title: '查最近修改', text: '列出最近7天修改过的文件' },
        { title: '查空目录', text: '列出当前项目下所有空的文件夹' },
        { title: '查大文件', text: '找出当前目录下超过 100MB 的文件' },
        { title: '查重复文件', text: '扫描当前目录下可能重复的文件' },
        { title: '查压缩包', text: '列出当前目录下所有 zip 文件及大小' },
        { title: '查图片', text: '统计当前目录下所有图片文件数量和总大小' },
        { title: '查PDF', text: '统计当前目录下所有 PDF 文件列表' },
        { title: '查视频', text: '列出当前目录下所有视频文件及时长' },
        { title: '查音乐文件', text: '列出当前目录下所有 mp3 文件' },
        { title: '查进程', text: '列出当前占用内存最多的10个进程' },
        { title: '查端口', text: '查看本机 3000 端口是否被占用' },
        { title: '查磁盘', text: '查看当前磁盘剩余空间' },
        { title: '查内存', text: '查看当前系统内存使用详情' },
        { title: '查CPU', text: '查看当前 CPU 型号和使用率' },
        { title: '查显示器', text: '查看当前显示器分辨率和刷新率' },
        { title: '查电池', text: '查看 MacBook 电池健康度和循环次数' },
        { title: '查蓝牙', text: '查看当前连接的蓝牙设备列表' },
        { title: '查启动项', text: '查看 macOS 当前开机启动项列表' },
        { title: '查网络信息', text: '列出当前网络连接信息和IP地址' },
        { title: '查环境变量', text: '列出所有 Node.js 相关的环境变量' },
        { title: '查剪贴板', text: '读取当前系统剪贴板内容' },
        { title: '查日历', text: '查看今天日期和本周日程安排' },
        { title: '查时区', text: '列出世界主要城市的当前时间' },
        { title: '查证书', text: '查看 github.com 的 SSL 证书过期时间' },
        { title: '查网站状态', text: '检测 github.com 是否可以正常访问' },
      ],
    },
  ],
};

// 英文默认建议（与中文一一对应）；中国特有事项映射为对应的通用概念。
export const SUGGESTION_DEFAULTS_EN: SuggestionDefaults = {
  chat: [
    { title: 'Explain a concept', text: 'Explain the basic principles of quantum computing' },
    { title: 'Write code', text: 'Write a quicksort algorithm in Python' },
    { title: 'Write an email', text: 'Help me write a leave-request email citing a family emergency' },
    { title: 'Compare tech', text: 'Compare the pros and cons of React and Vue' },
  ],
  agent: [
    {
      id: 'life',
      label: 'Daily life',
      items: [
        { title: 'Search weather', text: "Open the browser and search today's weather" },
        { title: 'Weather forecast', text: "Open the browser and search Beijing's 3-day weather forecast" },
        { title: 'Exchange rate', text: "Open the browser and look up today's USD to CNY exchange rate" },
        { title: 'Stock price', text: "Open the browser and search Apple's latest stock price" },
        { title: 'Fuel price', text: "Open the browser and look up today's gasoline price" },
        { title: 'Air quality', text: "Open the browser and search Beijing's air quality index today" },
        { title: 'Recipe', text: 'Search how to make scrambled eggs with tomato, list ingredients and steps' },
        { title: 'Flights', text: 'Search tomorrow’s flights from Beijing to Shanghai' },
        { title: 'Train tickets', text: 'Search tomorrow’s high-speed rail tickets from Beijing to Shanghai' },
        { title: 'Travel', text: 'Search the top 10 attractions in Hangzhou and ticket prices' },
        { title: 'Movies', text: 'Search the list of movies now playing this week' },
        { title: 'Books', text: 'Search the rating and synopsis of "The Three-Body Problem"' },
        { title: 'Music', text: 'Search this week’s trending new Mandarin songs' },
        { title: 'Horoscope', text: "Search today's Aries horoscope" },
        { title: 'Fitness', text: 'Search a beginner-friendly home workout plan' },
        { title: 'Wellness', text: 'Search dietary wellness tips for spring' },
        { title: 'Driving rules', text: "Search the latest changes to the driver's license test" },
        { title: 'Home prices', text: 'Search the latest average resale home price in Beijing Chaoyang' },
        { title: 'Rentals', text: 'Search one-bedroom rental prices in Beijing Haidian' },
        { title: 'Housing fund', text: "Search Beijing's latest housing provident fund policy" },
        { title: 'Social security', text: 'Search the latest social security contribution base' },
        { title: 'Health insurance', text: "Search Beijing's latest medical insurance reimbursement rates" },
        { title: 'Income tax', text: 'Search the latest personal income tax calculation method' },
        { title: 'Credit card', text: 'Search the latest credit card offers from China Merchants Bank' },
        { title: 'Outbreak', text: 'Search the latest flu outbreak data' },
        { title: 'Holidays', text: "Search this year's public holiday schedule" },
      ],
    },
    {
      id: 'work',
      label: 'Work & office',
      items: [
        { title: 'Web summary', text: 'Fetch the content of https://finance.sina.com.cn and summarize the key economic news' },
        { title: 'Search news', text: 'Search the latest AI tech news and summarize the top 5' },
        { title: 'Read a doc', text: 'Read README.md and summarize it' },
        { title: 'Translate a doc', text: 'Read README.md and translate it into English' },
        { title: 'Generate report', text: 'Read package.json and generate a project dependency report' },
        { title: 'Find papers', text: 'Search recent papers on large language models, list titles and abstracts' },
        { title: 'Job postings', text: 'Search the latest frontend engineer job requirements' },
        { title: 'Interview Qs', text: 'Search the top 10 frequently asked frontend interview questions' },
        { title: 'English', text: 'Search common business English email templates' },
        { title: 'PPT templates', text: 'Search recommended free PPT template download sites' },
      ],
    },
    {
      id: 'dev',
      label: 'Dev helpers',
      items: [
        { title: 'Analyze code', text: 'Search all TODO comments in the project and list them' },
        { title: 'Run script', text: 'Run node -e "console.log(process.version)" to check the current Node version' },
        { title: 'Find TODOs', text: 'Search all TODO and FIXME comments across source files' },
        { title: 'Find console.log', text: 'Search all console.log calls in the frontend code' },
        { title: 'Project structure', text: "Analyze this repo's main modules from its structure and dependencies" },
        { title: 'Count LOC', text: 'Count lines of code by file type in the project' },
        { title: 'Git status', text: 'Check the current project Git status and recent commits' },
        { title: 'Dep versions', text: 'Check the latest versions of dependencies in package.json' },
        { title: 'Vulnerabilities', text: 'Run npm audit to check the project dependencies for security issues' },
        { title: 'NPM package', text: 'Search the NPM download count and version info for lodash' },
        { title: 'Open source', text: 'Search the most popular AI projects on GitHub' },
        { title: 'API docs', text: 'Open the browser and search the latest OpenAI API docs' },
        { title: 'Docker', text: 'List the currently running Docker containers and images' },
        { title: 'Regex', text: 'Write a regex that matches email addresses and test it' },
        { title: 'Cron', text: 'Write a cron expression that runs every day at 9am' },
        { title: 'SQL', text: 'Write a SQL query: top 10 customers by sales in descending order' },
        { title: 'IDE errors', text: 'Check which files in this project have errors or warnings in IDEA' },
        { title: 'Run configs', text: 'Check the run configurations in IDEA and which is best for local startup' },
        { title: 'Editor context', text: "Check which files are open in IDEA and infer what I'm most likely working on" },
        { title: 'Symbol impact', text: "Based on the IDE's understanding, judge what renaming this class affects" },
        { title: 'Refactor plan', text: 'This change touches references; handle it with a safer refactoring approach' },
      ],
    },
    {
      id: 'sys',
      label: 'System',
      items: [
        { title: 'View files', text: 'Show the file structure of the current directory' },
        { title: 'Screenshot', text: 'Take a screenshot of the current screen' },
        { title: 'Organize files', text: 'List all .log files in the current directory and total their size' },
        { title: 'Recent changes', text: 'List files modified in the last 7 days' },
        { title: 'Empty dirs', text: 'List all empty folders under the current project' },
        { title: 'Large files', text: 'Find files over 100MB in the current directory' },
        { title: 'Duplicates', text: 'Scan the current directory for possible duplicate files' },
        { title: 'Archives', text: 'List all zip files in the current directory and their sizes' },
        { title: 'Images', text: 'Count all image files in the current directory and their total size' },
        { title: 'PDFs', text: 'List all PDF files in the current directory' },
        { title: 'Videos', text: 'List all video files in the current directory and their durations' },
        { title: 'Music files', text: 'List all mp3 files in the current directory' },
        { title: 'Processes', text: 'List the 10 processes using the most memory' },
        { title: 'Ports', text: 'Check whether port 3000 is in use on this machine' },
        { title: 'Disk', text: 'Check the remaining disk space' },
        { title: 'Memory', text: 'Check the current system memory usage details' },
        { title: 'CPU', text: 'Check the current CPU model and usage' },
        { title: 'Display', text: 'Check the current display resolution and refresh rate' },
        { title: 'Battery', text: 'Check the MacBook battery health and cycle count' },
        { title: 'Bluetooth', text: 'List the currently connected Bluetooth devices' },
        { title: 'Startup items', text: 'List the current macOS login/startup items' },
        { title: 'Network', text: 'List the current network connections and IP address' },
        { title: 'Env vars', text: 'List all Node.js-related environment variables' },
        { title: 'Clipboard', text: 'Read the current system clipboard content' },
        { title: 'Calendar', text: "Check today's date and this week's schedule" },
        { title: 'Time zones', text: 'List the current time in major world cities' },
        { title: 'Certificate', text: 'Check the SSL certificate expiry for github.com' },
        { title: 'Site status', text: 'Check whether github.com is reachable' },
      ],
    },
  ],
};

// 按语言取默认建议（en → 英文，其它 → 中文）。
export function getSuggestionDefaults(locale: SuggestionLocale): SuggestionDefaults {
  return locale === 'en' ? SUGGESTION_DEFAULTS_EN : SUGGESTION_DEFAULTS;
}
