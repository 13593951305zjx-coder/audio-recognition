package com.example.audioinsight.ui;

import android.app.Activity;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.widget.*;
import com.example.audioinsight.data.*;
import java.util.*;

public class ImportActivity extends UiActivity {
    private final ArrayList<Long> ids=new ArrayList<>();
    private LinearLayout queue;
    private TextView state;
    private Button choose,submit;
    private boolean importing,submitting;
    @Override public void onCreate(Bundle s){super.onCreate(s);if(s!=null){long[] a=s.getLongArray("ids");if(a!=null)for(long id:a)ids.add(id);}page("导入声音","支持音频与视频 · 一次最多 10 个",true,-1);LinearLayout c=card();TextView icon=text("＋",48,CYAN);icon.setGravity(android.view.Gravity.CENTER);c.addView(icon);TextView heading=text("把已有文件带进来",21,INK);heading.setGravity(android.view.Gravity.CENTER);c.addView(heading);TextView help=text("可选择手机或云盘中的音视频。\n选择后先复制到本机，确认后再提交整理。\n每个文件最长 5 分钟、最大 50 MB。",14,MUTED);help.setGravity(android.view.Gravity.CENTER);help.setPadding(0,dp(14),0,dp(10));c.addView(help);choose=addButton(c,"选择音频 / 视频",true,v->choose());state=note("尚未选择文件");queue=column();body.addView(queue);submit=addButton(body,"提交待处理文件",true,v->submitAll(0,new ArrayList<>(ids)));addButton(body,"前往历史查看全部任务",false,v->open(HistoryActivity.class));note("提交前请在设置中检测连接，并保持 USB 数据线与电脑服务连接。较大的视频需要更长时间上传。");load();}
    private void choose(){Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("*/*");intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"audio/*","video/*"});intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);try{startActivityForResult(intent,51);}catch(ActivityNotFoundException e){error("设备没有可用的文件选择器。");}}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request!=51||result!=Activity.RESULT_OK||data==null)return;LinkedHashSet<Uri> unique=new LinkedHashSet<>();ClipData clips=data.getClipData();if(clips!=null)for(int i=0;i<clips.getItemCount()&&unique.size()<10;i++)unique.add(clips.getItemAt(i).getUri());else if(data.getData()!=null)unique.add(data.getData());if(clips!=null&&clips.getItemCount()>10)toast("本次已选取前 10 个文件");ArrayList<Uri> files=new ArrayList<>(unique);for(Uri u:files){try{getContentResolver().takePersistableUriPermission(u,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}}if(!files.isEmpty()){importing=true;updateButtons();importNext(files,0,0);}}
    private void importNext(ArrayList<Uri> uris,int index,int failed){if(index>=uris.size()){importing=false;state.setText("已导入 "+(uris.size()-failed)+" 个文件"+(failed>0?"，"+failed+" 个读取失败":""));updateButtons();load();return;}state.setText("正在导入 "+(index+1)+" / "+uris.size()+"，请稍候…");repo.importUri(uris.get(index),new Callback<RecordInfo>(){public void onSuccess(RecordInfo r){ids.add(r.id);load();importNext(uris,index+1,failed);}public void onError(String m){toast(m);importNext(uris,index+1,failed+1);}});}
    private void submitAll(int index,List<Long> batch){if(batch.isEmpty()){toast("请先选择文件");return;}if(index==0){submitting=true;updateButtons();}if(index>=batch.size()){submitting=false;updateButtons();toast("文件已加入整理队列");load();return;}repo.loadRecord(batch.get(index),new Callback<RecordInfo>(){public void onSuccess(RecordInfo r){if(r.hasResult()||(!"Draft".equalsIgnoreCase(r.status)&&!"Failed".equalsIgnoreCase(r.status)&&!"Error".equalsIgnoreCase(r.status))){submitAll(index+1,batch);return;}repo.submit(r.id,new Callback<RecordInfo>(){public void onSuccess(RecordInfo r){submitAll(index+1,batch);}public void onError(String m){toast(m);submitAll(index+1,batch);}});}public void onError(String m){submitAll(index+1,batch);}});}
    @Override protected void onRecordsChanged(){load();}
    private void load(){if(queue==null)return;repo.loadRecords("",false,new Callback<List<RecordInfo>>(){public void onSuccess(List<RecordInfo> list){if(isFinishing())return;queue.removeAllViews();int shown=0;for(RecordInfo r:list)if(ids.contains(r.id)){recordCard(queue,r,false);shown++;}if(!importing&&!submitting)state.setText(shown==0?"尚未选择文件":"本次已导入 "+shown+" 个文件 · 点击记录查看详情");updateButtons();}public void onError(String m){state.setText(m);}});}
    private void updateButtons(){if(choose!=null){choose.setEnabled(!importing&&!submitting);submit.setEnabled(!importing&&!submitting&&!ids.isEmpty());}}
    @Override protected void onSaveInstanceState(Bundle b){long[] a=new long[ids.size()];for(int i=0;i<a.length;i++)a[i]=ids.get(i);b.putLongArray("ids",a);super.onSaveInstanceState(b);}
}
