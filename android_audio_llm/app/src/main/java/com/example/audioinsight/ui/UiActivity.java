package com.example.audioinsight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import com.example.audioinsight.data.AppRepository;
import com.example.audioinsight.data.Callback;
import com.example.audioinsight.data.RecordInfo;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Shared native widgets. Every size is expressed in dp. */
public abstract class UiActivity extends Activity {
    public static final int BG=Color.rgb(13,16,32), PANEL=Color.rgb(26,31,52), INK=Color.rgb(242,244,255), MUTED=Color.rgb(159,170,198), CYAN=Color.rgb(101,216,205), PURPLE=Color.rgb(160,139,255);
    protected LinearLayout shell, body;
    protected AppRepository repo;
    protected boolean active;
    private final Runnable observer=() -> onRecordsChanged();
    @Override public void onCreate(Bundle state) { super.onCreate(state); repo=AppRepository.get(this); getWindow().setStatusBarColor(BG); getWindow().setNavigationBarColor(BG); }
    @Override protected void onStart(){super.onStart();active=true;repo.observe(observer);}
    @Override protected void onStop(){active=false;repo.removeObserver(observer);super.onStop();}
    protected void onRecordsChanged() { }
    protected void page(String title,String subtitle,boolean back,int nav){
        shell=new LinearLayout(this);shell.setOrientation(LinearLayout.VERTICAL);shell.setBackgroundColor(BG);shell.setFitsSystemWindows(true);setContentView(shell);
        LinearLayout header=new LinearLayout(this);header.setGravity(Gravity.CENTER_VERTICAL);header.setPadding(dp(20),dp(12),dp(20),dp(12));
        if(back){TextView b=text("‹",32,INK);b.setGravity(Gravity.CENTER);b.setContentDescription("返回");header.addView(b,new LinearLayout.LayoutParams(dp(48),dp(48)));b.setOnClickListener(v->finish());}
        LinearLayout heading=column();TextView t=text(title,23,INK);t.setTypeface(null,Typeface.BOLD);heading.addView(t);if(subtitle!=null&&!subtitle.isEmpty())heading.addView(text(subtitle,12,MUTED));header.addView(heading,new LinearLayout.LayoutParams(0,-2,1));shell.addView(header);
        ScrollView sc=new ScrollView(this);sc.setFillViewport(true);sc.setClipToPadding(false);body=column();body.setPadding(dp(20),dp(8),dp(20),dp(24));sc.addView(body,new ScrollView.LayoutParams(-1,-2));shell.addView(sc,new LinearLayout.LayoutParams(-1,0,1));if(nav>=0)bottom(nav);
    }
    protected void bottom(int selected){LinearLayout row=new LinearLayout(this);row.setPadding(dp(12),dp(4),dp(12),dp(8));row.setBackgroundColor(Color.rgb(17,21,39));String[] labels={"⌂  首页","◷  历史","▥  分析","⚙  设置"};Class<?>[] pages={HomeActivity.class,HistoryActivity.class,StatsActivity.class,SettingsActivity.class};for(int i=0;i<labels.length;i++){final int n=i;TextView t=text(labels[i],12,i==selected?CYAN:MUTED);t.setGravity(Gravity.CENTER);t.setMinHeight(dp(56));row.addView(t,new LinearLayout.LayoutParams(0,dp(56),1));t.setOnClickListener(v->{if(n!=selected)startActivity(new Intent(this,pages[n]).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));});}shell.addView(row);}
    protected int dp(float n){return (int)(getResources().getDisplayMetrics().density*n+.5f);}
    protected LinearLayout column(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.VERTICAL);return l;}
    protected LinearLayout row(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.HORIZONTAL);l.setGravity(Gravity.CENTER_VERTICAL);return l;}
    protected TextView text(String s,float size,int color){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);t.setLineSpacing(dp(3),1);return t;}
    protected TextView label(String s){TextView t=text(s,16,INK);t.setTypeface(null,Typeface.BOLD);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(22);p.bottomMargin=dp(12);body.addView(t,p);return t;}
    protected TextView note(String s){TextView t=text(s,13,MUTED);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(10);p.bottomMargin=dp(10);body.addView(t,p);return t;}
    protected GradientDrawable rounded(int color,int stroke){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(20));if(stroke!=0)d.setStroke(dp(1),stroke);return d;}
    protected LinearLayout card(){LinearLayout l=column();l.setPadding(dp(18),dp(18),dp(18),dp(18));l.setBackground(rounded(PANEL,Color.rgb(44,51,78)));LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(12);body.addView(l,p);return l;}
    protected Button button(String s,boolean primary){Button b=new Button(this);b.setText(s);b.setTextSize(14);b.setTextColor(primary?BG:INK);b.setAllCaps(false);b.setMinHeight(dp(50));b.setMinimumHeight(dp(50));b.setPadding(dp(16),0,dp(16),0);b.setBackground(rounded(primary?CYAN:Color.rgb(42,48,75),0));LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(52));p.topMargin=dp(10);b.setLayoutParams(p);return b;}
    protected Button addButton(LinearLayout p,String s,boolean primary,View.OnClickListener action){Button b=button(s,primary);p.addView(b);b.setOnClickListener(action);return b;}
    protected void pair(LinearLayout p,String a,View.OnClickListener aa,String b,View.OnClickListener bb){LinearLayout row=row();Button ba=button(a,true),bc=button(b,false);LinearLayout.LayoutParams x=new LinearLayout.LayoutParams(0,dp(52),1);x.topMargin=dp(12);x.rightMargin=dp(5);row.addView(ba,x);LinearLayout.LayoutParams y=new LinearLayout.LayoutParams(0,dp(52),1);y.topMargin=dp(12);y.leftMargin=dp(5);row.addView(bc,y);ba.setOnClickListener(aa);bc.setOnClickListener(bb);p.addView(row);}
    protected EditText input(String hint){EditText e=new EditText(this);e.setTextColor(INK);e.setHintTextColor(MUTED);e.setTextSize(14);e.setHint(hint);e.setSingleLine();e.setPadding(dp(16),dp(10),dp(16),dp(10));e.setBackground(rounded(Color.rgb(21,26,45),Color.rgb(52,61,88)));e.setMinHeight(dp(52));return e;}
    protected void open(Class<?> c){startActivity(new Intent(this,c));}
    protected void openRecord(long id){startActivity(new Intent(this,ResultActivity.class).putExtra("record_id",id));}
    protected void toast(String s){if(!isFinishing())Toast.makeText(this,s,Toast.LENGTH_LONG).show();}
    protected void error(String s){if(!isFinishing()&&!isDestroyed()&&active)new AlertDialog.Builder(this).setTitle("暂时无法完成").setMessage(s).setPositiveButton("知道了",null).show();}
    protected void copy(String label,String s){((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText(label,s));toast("已复制到剪贴板");}
    protected String duration(double sec){long s=Math.max(0,(long)sec);return String.format(Locale.CHINA,"%02d:%02d",s/60,s%60);}
    protected String when(long time){return new SimpleDateFormat("MM月dd日 HH:mm",Locale.CHINA).format(new Date(time));}
    protected String status(String s){return RecordInfo.statusLabel(s); }
    protected void recordCard(LinearLayout parent,RecordInfo r,boolean options){LinearLayout box=column();box.setPadding(dp(16),dp(16),dp(16),dp(16));box.setBackground(rounded(PANEL,Color.rgb(44,51,78)));LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(10);parent.addView(box,lp);LinearLayout top=row();TextView title=text((r.favorite?"★  ":"")+r.title,16,INK);title.setTypeface(null,Typeface.BOLD);title.setMaxLines(2);top.addView(title,new LinearLayout.LayoutParams(0,-2,1));TextView tag=text(status(r.status),11,r.hasResult()?CYAN:PURPLE);tag.setPadding(dp(8),dp(6),dp(8),dp(6));top.addView(tag);box.addView(top);TextView meta=text(when(r.createdAt)+"  ·  "+duration(r.duration)+(r.isVideo()?"  ·  视频":"  ·  音频"),12,MUTED);meta.setPadding(0,dp(8),0,0);box.addView(meta);String preview=r.transcript();if(preview!=null&&!preview.isEmpty()){TextView p=text(preview,13,MUTED);p.setMaxLines(2);p.setPadding(0,dp(8),0,0);box.addView(p);}box.setOnClickListener(v->openRecord(r.id));if(options)addButton(box,"管理记录",false,v->manage(r));}
    protected void manage(RecordInfo r){String[] actions={r.favorite?"取消收藏":"收藏记录","重命名","删除记录"};new AlertDialog.Builder(this).setTitle(r.title).setItems(actions,(d,n)->{if(n==0)repo.updateMeta(r.id,r.title,!r.favorite,new Callback<RecordInfo>(){public void onSuccess(RecordInfo x){onRecordsChanged();}public void onError(String m){error(m);}});else if(n==1){EditText e=input("记录名称");e.setText(r.title);LinearLayout wrap=column();wrap.setPadding(dp(20),dp(8),dp(20),dp(8));wrap.addView(e);new AlertDialog.Builder(this).setTitle("重命名").setView(wrap).setNegativeButton("取消",null).setPositiveButton("保存",(x,y)->{String title=e.getText().toString().trim();if(!title.isEmpty())repo.updateMeta(r.id,title,r.favorite,new Callback<RecordInfo>(){public void onSuccess(RecordInfo a){onRecordsChanged();}public void onError(String m){error(m);}});}).show();}else new AlertDialog.Builder(this).setTitle("删除这条记录？").setMessage("本机的记录和关联文件将被删除。").setNegativeButton("保留",null).setPositiveButton("删除",(x,y)->repo.delete(r.id,new Callback<Void>(){public void onSuccess(Void z){onRecordsChanged();}public void onError(String m){error(m);}})).show();}).show();}
}
