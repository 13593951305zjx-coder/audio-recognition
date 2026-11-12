package com.example.audioinsight.ui;
import android.os.*;
import android.text.*;
import android.widget.*;
import com.example.audioinsight.data.*;
import java.util.List;
public class HistoryActivity extends UiActivity {
    private EditText search;private LinearLayout records;private TextView total;private boolean favorites;private Button filter;private final Handler handler=new Handler(Looper.getMainLooper());private final Runnable reload=()->load();
    @Override public void onCreate(Bundle s){super.onCreate(s);page("声音资料库","本机记录 · 随时回看",false,1);search=input("搜索名称或转写内容");body.addView(search);search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int c,int f){}public void onTextChanged(CharSequence s,int a,int b,int c){handler.removeCallbacks(reload);handler.postDelayed(reload,250);}public void afterTextChanged(Editable e){}});LinearLayout actions=row();filter=button("☆  只看收藏",false);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,dp(50),1);p.topMargin=dp(12);p.rightMargin=dp(5);actions.addView(filter,p);Button sync=button("同步服务记录",false);LinearLayout.LayoutParams q=new LinearLayout.LayoutParams(0,dp(50),1);q.topMargin=dp(12);q.leftMargin=dp(5);actions.addView(sync,q);body.addView(actions);filter.setOnClickListener(v->{favorites=!favorites;filter.setText(favorites?"★  已筛选收藏":"☆  只看收藏");load();});sync.setOnClickListener(v->{sync.setEnabled(false);repo.syncHistory(new Callback<Integer>(){public void onSuccess(Integer n){sync.setEnabled(true);toast("已同步 "+n+" 条记录");load();}public void onError(String m){sync.setEnabled(true);error(m);}});});total=note("正在读取…");records=column();body.addView(records);}
    @Override protected void onResume(){super.onResume();load();}@Override protected void onRecordsChanged(){load();}
    private void load(){if(records==null)return;repo.loadRecords(search.getText().toString(),favorites,new Callback<List<RecordInfo>>(){public void onSuccess(List<RecordInfo> all){if(isFinishing())return;records.removeAllViews();total.setText("共 "+all.size()+" 条记录"+(favorites?" · 仅收藏":""));if(all.isEmpty()){TextView e=text("没有找到记录\n试试其他关键词，或导入一段新声音。",15,MUTED);e.setPadding(0,dp(30),0,dp(30));records.addView(e);}for(RecordInfo r:all)recordCard(records,r,true);}public void onError(String m){total.setText("读取失败："+m);}});}
    @Override protected void onDestroy(){handler.removeCallbacks(reload);super.onDestroy();}
}
