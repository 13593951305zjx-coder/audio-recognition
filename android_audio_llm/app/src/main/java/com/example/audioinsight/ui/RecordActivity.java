package com.example.audioinsight.ui;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.*;
import android.media.MediaRecorder;
import android.os.*;
import android.view.*;
import android.widget.*;
import com.example.audioinsight.data.*;
import java.io.File;
import java.util.Locale;

/** Records locally before a user explicitly submits the saved recording. */
public class RecordActivity extends UiActivity {
    private MediaRecorder recorder;
    private File file;
    private boolean recording,saving;
    private long startedAt,savedId=-1;
    private TextView timer,state;
    private Button control,submit,view;
    private VolumeView levels;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable meter=new Runnable(){public void run(){if(!recording||recorder==null)return;timer.setText(duration((SystemClock.elapsedRealtime()-startedAt)/1000.0));try{levels.add(recorder.getMaxAmplitude()/32767f);}catch(RuntimeException ignored){}handler.postDelayed(this,100);}};
    @Override public void onCreate(Bundle bundle){super.onCreate(bundle);if(bundle!=null)savedId=bundle.getLong("saved_id",-1);page("现场录音","先保存到本机，再提交整理",true,-1);LinearLayout c=card();TextView mark=text("LIVE RECORDING",11,CYAN);mark.setLetterSpacing(.12f);mark.setGravity(Gravity.CENTER);c.addView(mark);timer=text("00:00",54,INK);timer.setTypeface(android.graphics.Typeface.MONOSPACE);timer.setGravity(Gravity.CENTER);timer.setPadding(0,dp(26),0,dp(18));c.addView(timer);levels=new VolumeView();c.addView(levels,new LinearLayout.LayoutParams(-1,dp(100)));state=text(savedId>0?"上次录音已保存在本机":"轻触下方按钮，开始记录声音",14,MUTED);state.setGravity(Gravity.CENTER);state.setPadding(0,dp(16),0,dp(16));c.addView(state);control=addButton(c,"●  开始录音",true,v->{if(recording)stopRecording(true);else requestRecording();});submit=addButton(body,"提交录音并整理",true,v->submit());view=addButton(body,"查看已保存的录音",false,v->openRecord(savedId));updateActions();label("录音小提示");LinearLayout tips=card();tips.addView(text("靠近声源，保持环境安静。\n录音过程中保持此页面打开；离开页面时会自动结束并保存。\n每段最长 5 分钟，到时自动结束。\n录音保存在本机，USB 连接电脑服务后再提交。",14,MUTED));addButton(body,"检查服务连接",false,v->open(SettingsActivity.class));}
    private void requestRecording(){if(saving)return;if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},41);return;}startRecording();}
    @Override public void onRequestPermissionsResult(int request,String[] names,int[] grants){super.onRequestPermissionsResult(request,names,grants);if(request==41){if(grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED)startRecording();else error("录音需要麦克风权限。你也可以返回首页，导入手机里已有的文件。");}}
    private void startRecording(){try{File dir=new File(getFilesDir(),"audio");if(!dir.exists()&&!dir.mkdirs())throw new java.io.IOException("无法创建录音目录");file=new File(dir,"recording_"+System.currentTimeMillis()+".m4a");recorder=new MediaRecorder();recorder.setAudioSource(MediaRecorder.AudioSource.MIC);recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);recorder.setAudioSamplingRate(44100);recorder.setAudioEncodingBitRate(128000);recorder.setMaxDuration(300000);recorder.setOnInfoListener((mr,what,extra)->{if(what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED){stopRecording(true);toast("已达到 5 分钟，录音已自动结束并保存");}});recorder.setOutputFile(file.getAbsolutePath());recorder.prepare();recorder.start();recording=true;savedId=-1;startedAt=SystemClock.elapsedRealtime();control.setText("■  结束并保存");state.setText("●  正在录音 · 最长 5 分钟");state.setTextColor(CYAN);levels.clear();updateActions();handler.post(meter);}catch(Exception e){releaseRecorder();if(file!=null)file.delete();error("无法开始录音。请检查麦克风是否被其他应用占用。");}}
    private void stopRecording(boolean feedback){if(!recording)return;double sec=(SystemClock.elapsedRealtime()-startedAt)/1000.0;recording=false;handler.removeCallbacks(meter);try{recorder.stop();}catch(RuntimeException e){releaseRecorder();if(file!=null)file.delete();state.setText("录音太短，未能保存，请再试一次");control.setText("●  重新录音");updateActions();return;}releaseRecorder();saving=true;control.setEnabled(false);state.setText("正在保存录音…");repo.addRecording(file,sec,new Callback<RecordInfo>(){public void onSuccess(RecordInfo r){saving=false;savedId=r.id;state.setText("已保存到本机 · "+duration(r.duration));state.setTextColor(CYAN);control.setEnabled(true);control.setText("●  再录一段");updateActions();if(feedback)toast("录音已保存，可以提交整理");}public void onError(String m){saving=false;control.setEnabled(true);state.setText("保存失败："+m);updateActions();if(feedback)error(m);}});}
    private void submit(){if(savedId<0||recording||saving)return;submit.setEnabled(false);repo.submit(savedId,new Callback<RecordInfo>(){public void onSuccess(RecordInfo r){submit.setEnabled(true);openRecord(r.id);}public void onError(String m){submit.setEnabled(true);error(m);}});}
    private void updateActions(){if(submit!=null){submit.setEnabled(savedId>0&&!recording&&!saving);view.setEnabled(savedId>0&&!recording&&!saving);}}
    private void releaseRecorder(){if(recorder!=null){try{recorder.release();}catch(RuntimeException ignored){}recorder=null;}}
    @Override protected void onStop(){if(recording)stopRecording(false);super.onStop();}
    @Override protected void onDestroy(){handler.removeCallbacks(meter);releaseRecorder();super.onDestroy();}
    @Override protected void onSaveInstanceState(Bundle out){out.putLong("saved_id",savedId);super.onSaveInstanceState(out);}
    private class VolumeView extends View{private final float[] samples=new float[34];private final Paint p=new Paint(3);VolumeView(){super(RecordActivity.this);setContentDescription("实时录音音量条");}void add(float n){System.arraycopy(samples,1,samples,0,samples.length-1);samples[samples.length-1]=Math.min(1,Math.max(0,n));invalidate();}void clear(){java.util.Arrays.fill(samples,0);invalidate();}protected void onDraw(Canvas c){float gap=getWidth()/(float)samples.length;for(int i=0;i<samples.length;i++){p.setColor(i%3==0?PURPLE:CYAN);p.setAlpha((int)(90+165*samples[i]));float h=dp(4)+samples[i]*(getHeight()-dp(8));float x=gap*i+gap/2;c.drawRoundRect(x-gap*.27f,(getHeight()-h)/2,x+gap*.27f,(getHeight()+h)/2,dp(3),dp(3),p);}}}
}
