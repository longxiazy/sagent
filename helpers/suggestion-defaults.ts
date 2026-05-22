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
        { title: '查快递', text: '帮我搜索快递单号 SF1234567890 的物流信息' },
        { title: '查菜谱', text: '搜索番茄炒蛋的做法,列出食材和步骤' },
        { title: '查航班', text: '搜索明天北京到上海的航班信息' },
        { title: '查火车票', text: '搜索明天北京到上海的高铁票信息' },
        { title: '查旅游', text: '搜索杭州必去的十大景点及门票价格' },
        { title: '查电影', text: '搜索本周正在热映的电影列表' },
        { title: '查图书', text: '搜索《三体》的豆瓣评分和简介' },
        { title: '查音乐', text: '搜索 Spotify 最热门的中文歌曲排行' },
        { title: '查星座', text: '搜索今日白羊座运势' },
        { title: '查健身', text: '搜索适合初学者的家庭健身计划' },
        { title: '查养生', text: '搜索春季养生饮食注意事项' },
        { title: '查驾照', text: '打开浏览器查询驾照违章扣分情况' },
        { title: '查驾照新规', text: '搜索2025年驾照考试最新规定' },
        { title: '查房价', text: '搜索北京朝阳区最新二手房均价' },
        { title: '查租房', text: '搜索北京海淀区一居室租房价格' },
        { title: '查公积金', text: '搜索北京住房公积金最新政策' },
        { title: '查社保', text: '搜索2025年社保缴费基数标准' },
        { title: '查医保', text: '搜索北京医保报销比例最新标准' },
        { title: '查个税', text: '搜索最新个人所得税计算方法' },
        { title: '查信用卡', text: '搜索招商银行信用卡最新优惠活动' },
        { title: '查疫情', text: '搜索最新的流感疫情数据' },
        { title: '查表情包', text: '搜索最近流行的搞笑表情包' },
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
        { title: '查WiFi密码', text: '列出当前网络连接信息和IP地址' },
        { title: '查环境变量', text: '列出所有 Node.js 相关的环境变量' },
        { title: '查剪贴板', text: '读取当前系统剪贴板内容' },
        { title: '查日历', text: '查看今天日期和本周日程安排' },
        { title: '查时区', text: '列出世界主要城市的当前时间' },
        { title: '查证书', text: '查看 google.com 的 SSL 证书过期时间' },
        { title: '查网站状态', text: '检测 github.com 是否可以正常访问' },
      ],
    },
  ],
};
