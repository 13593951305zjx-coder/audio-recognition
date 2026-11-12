package com.example.audioinsight.ui;
import android.os.Bundle;
import android.widget.LinearLayout;
public class AboutActivity extends UiActivity {
 @Override public void onCreate(Bundle s){super.onCreate(s);page("关于与使用指南","音频智记 · Android 课程作品",true,-1);LinearLayout hero=card();hero.addView(text("听见 · 重点",28,INK));hero.addView(text("记录声音  /  整理信息  /  回看行动",14,CYAN));label("三步开始");item("01  留下声音","在首页选择“开始录音”，允许麦克风权限；或导入已有音频、视频文件，一次最多 10 个。");item("02  提交整理","先用 USB 连接手机与电脑，运行电脑上的“手机连接”脚本，再在设置中检测服务并提交文件。处理期间可以查看历史记录中的状态。");item("03  回看重点","在结果页播放原声、按分句跳转，查看摘要和待办；也可以搜索关键词、修订分句、复制或导出文本。");label("课程功能说明");item("独立页面与导航","包含欢迎、首页、录音、导入、结果、历史、分析、设置、关于，共 9 个独立 Activity；欢迎页使用原生启动动画。");item("数据保存与多媒体","使用 SQLite 保存本机记录与任务状态；通过文件保存录音与导入资源。支持麦克风录音、音频播放、视频播放和时间定位。");item("二维绘图与分析","使用 Canvas 绘制实时音量、音高曲线和发言占比图；图表仅展示服务真实返回的数据，未分析时给出空态。");item("原生 Java 实现","应用使用 Java、Android 平台控件和系统文件选择器；可在 Android Studio 中构建运行。");note("使用须知：识别和摘要可能存在偏差，重要信息请结合原声核对。发言占比只是声音分段统计。电脑整理服务需要单独启动，并保持 USB 连接。");}
 private void item(String title,String detail){LinearLayout c=card();c.addView(text(title,17,INK));android.widget.TextView t=text(detail,14,MUTED);t.setPadding(0,dp(10),0,0);c.addView(t);}
}
