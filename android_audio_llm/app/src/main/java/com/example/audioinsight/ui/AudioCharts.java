package com.example.audioinsight.ui;

import android.content.Context;
import android.graphics.*;
import android.view.View;
import org.json.*;
import java.util.*;

/** Two dimensional charts drawn from measured service data only. */
public final class AudioCharts {
    public static final int[] COLORS={0xff65d8cd,0xffa08bff,0xffffc07a,0xff71adff,0xffed98c8,0xffadce87};
    private AudioCharts(){}
    public static class Pitch extends View {
        private final JSONArray points;private final Paint p=new Paint(3);private final float density;private double maxTime,maxHz,minHz;
        public Pitch(Context c,JSONObject stats){super(c);density=getResources().getDisplayMetrics().density;points=stats.optJSONArray("points");maxTime=stats.optDouble("durationSeconds",0);minHz=Double.POSITIVE_INFINITY;maxHz=0;if(points!=null)for(int i=0;i<points.length();i++){JSONObject x=points.optJSONObject(i);if(x==null)continue;maxTime=Math.max(maxTime,x.optDouble("time",0));double hz=x.isNull("hz")?0:x.optDouble("hz",0);if(hz>0&&Double.isFinite(hz)){minHz=Math.min(minHz,hz);maxHz=Math.max(maxHz,hz);}}if(!Double.isFinite(minHz)){minHz=0;maxHz=0;}setContentDescription(maxHz>0?"原声音高曲线，单位赫兹":"暂无有效音高数据");}
        @Override protected void onDraw(Canvas c){float left=42*density,right=getWidth()-12*density,top=20*density,bottom=getHeight()-28*density;p.setTypeface(Typeface.DEFAULT);p.setTextSize(10*density);p.setStrokeWidth(density);p.setStyle(Paint.Style.FILL);if(maxHz<=0||maxTime<=0){p.setColor(UiActivity.MUTED);p.setTextAlign(Paint.Align.CENTER);c.drawText("暂无有效音高数据",getWidth()/2f,getHeight()/2f,p);return;}double low=Math.max(0,minHz*.85),high=Math.max(low+20,maxHz*1.1);p.setTextAlign(Paint.Align.RIGHT);for(int i=0;i<4;i++){float y=top+(bottom-top)*i/3;p.setColor(0xff343c56);c.drawLine(left,y,right,y,p);p.setColor(UiActivity.MUTED);c.drawText(String.format(Locale.CHINA,"%.0f",high-(high-low)*i/3),left-6*density,y+3*density,p);}p.setTextAlign(Paint.Align.LEFT);c.drawText("Hz",left,top-6*density,p);c.drawText("0:00",left,bottom+19*density,p);p.setTextAlign(Paint.Align.RIGHT);c.drawText(String.format(Locale.CHINA,"%02d:%02d",(int)maxTime/60,(int)maxTime%60),right,bottom+19*density,p);Path path=new Path();boolean open=false;double previous=-1;for(int i=0;i<points.length();i++){JSONObject o=points.optJSONObject(i);if(o==null)continue;double hz=o.isNull("hz")?0:o.optDouble("hz",0),time=o.optDouble("time",0);if(hz<=0||!Double.isFinite(hz)){open=false;continue;}float x=left+(float)(time/maxTime)*(right-left),y=bottom-(float)((hz-low)/(high-low))*(bottom-top);if(!open||previous>=0&&time-previous>2)path.moveTo(x,y);else path.lineTo(x,y);previous=time;open=true;}p.setColor(UiActivity.CYAN);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(2*density);c.drawPath(path,p);p.setStyle(Paint.Style.FILL);}
    }
    public static class Shares extends View {
        private final List<Double> values;private final Paint p=new Paint(3);private final float density;private double total;
        public Shares(Context c,List<Double> data){super(c);density=getResources().getDisplayMetrics().density;values=data;for(double x:data)total+=Math.max(0,x);setContentDescription("按有效分句时长计算的发言占比环形图");}
        @Override protected void onDraw(Canvas c){float cx=getWidth()/2f,cy=getHeight()/2f,r=Math.min(getWidth(),getHeight())*.41f;p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(22*density);RectF bounds=new RectF(cx-r,cy-r,cx+r,cy+r);if(total<=0){p.setColor(0xff343c56);c.drawOval(bounds,p);}else{float angle=-90;for(int i=0;i<values.size();i++){float sweep=(float)(Math.max(0,values.get(i))/total*360);p.setColor(COLORS[i%COLORS.length]);c.drawArc(bounds,angle,sweep,false,p);angle+=sweep;}}p.setStyle(Paint.Style.FILL);p.setTextAlign(Paint.Align.CENTER);p.setColor(UiActivity.INK);p.setTextSize(23*density);p.setTypeface(Typeface.create("sans-serif",Typeface.BOLD));c.drawText(total>0?values.size()+" 位":"暂无数据",cx,cy,p);p.setTextSize(11*density);p.setTypeface(Typeface.DEFAULT);p.setColor(UiActivity.MUTED);c.drawText("发言者",cx,cy+22*density,p);}
    }
}
