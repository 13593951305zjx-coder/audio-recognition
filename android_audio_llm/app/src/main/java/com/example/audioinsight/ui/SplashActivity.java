package com.example.audioinsight.ui;
import android.animation.ValueAnimator;
import android.content.Intent;
import android.graphics.*;
import android.os.*;
import android.view.*;
import android.widget.*;
public class SplashActivity extends UiActivity {
    private final Handler handler=new Handler(Looper.getMainLooper());private ValueAnimator animator;
    private final Runnable onward=()->{if(!isFinishing()){startActivity(new Intent(this,HomeActivity.class));finish();}};
    @Override public void onCreate(Bundle state){super.onCreate(state);LinearLayout root=column();root.setGravity(Gravity.CENTER);root.setPadding(dp(30),dp(30),dp(30),dp(30));root.setBackground(new android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TL_BR,new int[]{0xff1e1641,BG,0xff102c36}));root.setFitsSystemWindows(true);setContentView(root);PulseLogo logo=new PulseLogo();root.addView(logo,new LinearLayout.LayoutParams(dp(180),dp(150)));TextView title=text("听见 · 重点",34,INK);title.setTypeface(null,Typeface.BOLD);title.setGravity(Gravity.CENTER);root.addView(title);TextView sub=text("让每一段声音，成为清晰的行动",14,MUTED);sub.setGravity(Gravity.CENTER);sub.setPadding(0,dp(16),0,dp(40));root.addView(sub);TextView mark=text("AUDIO INSIGHT  /  音频智记",10,CYAN);mark.setLetterSpacing(.12f);mark.setGravity(Gravity.CENTER);root.addView(mark);root.setAlpha(0);root.animate().alpha(1).setDuration(800).start();animator=ValueAnimator.ofFloat(0,1);animator.setDuration(1600);animator.setRepeatCount(ValueAnimator.INFINITE);animator.addUpdateListener(a->{logo.phase=(float)a.getAnimatedValue();logo.invalidate();});animator.start();handler.postDelayed(onward,2600);}
    @Override protected void onDestroy(){handler.removeCallbacks(onward);if(animator!=null)animator.cancel();super.onDestroy();}
    private class PulseLogo extends View{float phase;Paint paint=new Paint(3);PulseLogo(){super(SplashActivity.this);setContentDescription("声音波形启动动画");}protected void onDraw(Canvas c){float cx=getWidth()/2f,cy=getHeight()/2f;paint.setColor(0xff29274d);c.drawCircle(cx,cy,dp(64),paint);for(int i=0;i<7;i++){float h=dp(20)+(float)Math.abs(Math.sin(phase*Math.PI*2+i*.7))*dp(45);paint.setColor(i%2==0?CYAN:PURPLE);float x=cx+(i-3)*dp(13);c.drawRoundRect(x-dp(3),cy-h/2,x+dp(3),cy+h/2,dp(4),dp(4),paint);}}}
}
