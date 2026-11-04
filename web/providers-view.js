import {$,element,api,toast} from './api.js';
let signature='';
const order=['codex','antigravityDesktop','workbuddyDesktop','doubaoDesktop','antigravity','workbuddy'];
function feedback(box,message,error=false){const node=box.querySelector('.provider-action-status');node.textContent=message;node.classList.toggle('error-message',error);node.hidden=false;}
function busy(box,value){box.dataset.busy=value?'1':'';box.querySelectorAll('.provider-buttons button').forEach(button=>button.disabled=value);box.setAttribute('aria-busy',String(value));}
export function renderProviders(providers,refreshState){
  const next=JSON.stringify(providers || []);if(next===signature)return;signature=next;
  for(const provider of [...providers || []].sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id))){
    let box=$('provider-'+provider.id);
    if(!box){
      box=element('article','provider-setting');box.id='provider-'+provider.id;
      const heading=element('div','provider-heading');heading.append(element('span','provider-monogram '+provider.id,provider.id==='codex'?'C':provider.id.startsWith('antigravity')?'A':provider.id==='doubaoDesktop'?'豆':'W'),element('span','badge'));box.append(heading,element('h2','provider-title',provider.name),element('p','provider-kind',provider.id==='codex'?'本机 App Server':provider.capabilities.desktop?'桌面客户端':'独立命令行客户端'),element('p','provider-description'),element('p','provider-verification'));
      const status=element('p','provider-action-status');status.hidden=true;status.setAttribute('role','status');status.setAttribute('aria-live','polite');box.append(status);
      const buttons=element('div','provider-buttons');
      if(provider.id==='codex'){const reconnect=$('reconnect');reconnect.className='secondary';buttons.append(reconnect);}
      else{
        let binary;
        if(!provider.capabilities.desktop){binary=element('input');binary.type='text';binary.value=provider.binary || '';binary.setAttribute('aria-label',provider.name+' 程序路径');binary.placeholder='自动检测，或填写程序完整路径';box.append(binary);}
        for(const [verify,text]of [[false,'检测连接'],[true,'测试发送']]){
          const button=element('button',verify?'secondary':'primary',text);button.type='button';
          button.addEventListener('click',async()=>{
            busy(box,true);button.textContent=verify?'测试中…':'检测中…';feedback(box,verify?'正在检测连接并等待客户端的真实测试回复…':'正在检查客户端进程、端口和聊天界面…');
            const started=performance.now();
            try{const result=await api('providers/'+provider.id,'POST',{...(binary?{binary:binary.value}:{}),verify},verify?180000:45000);await refreshState();const verified=result.available&&result.verification?.status==='verified';const message=verify?(verified?'已收到真实测试回复，发送与完成检测通过。':result.verification?.error || result.detail):result.available?`连接已就绪，用时 ${((performance.now()-started)/1000).toFixed(1)} 秒。`:result.detail;feedback(box,message,verify?!verified:!result.available);toast(message,verify?!verified:!result.available);}
            catch(error){feedback(box,error.message,true);toast(error.message,true);}finally{busy(box,false);button.textContent=text;}
          });buttons.append(button);
        }
        if(['workbuddyDesktop','doubaoDesktop'].includes(provider.id)){
          const app=provider.id==='doubaoDesktop'?'doubao':'workbuddy';
          const launch=element('button','quiet desktop-launch','打开并连接');launch.type='button';launch.addEventListener('click',async()=>{busy(box,true);launch.textContent='正在连接…';feedback(box,'正在连接已有接口，或打开客户端并等待界面就绪…');try{const result=await api('desktop/'+app+'/launch','POST',{},100000);await refreshState();const message=result.connected?'客户端已连接，可以测试发送。':result.requiresRestart?result.provider.detail:'客户端已打开，但控制接口尚未就绪。请查看上方原因，界面加载后可重新检测。';feedback(box,message,!result.connected);toast(message,!result.connected);}catch(error){feedback(box,error.message,true);toast(error.message,true);}finally{busy(box,false);launch.textContent='打开并连接';}});buttons.append(launch);
          box.append(element('p','field-help desktop-launch-help','首次启用调试连接：保存任务并完全退出客户端，再点「打开并连接」。以后使用带连接参数的快捷方式，可先开客户端、再开工作台。'));
        }
      }
      box.append(buttons);(provider.capabilities.desktop || provider.id==='codex'?$('providerList'):$('cliProviderList')).append(box);
    }
    const badge=box.querySelector('.badge');badge.className='badge '+(provider.available?'completed':'paused');badge.textContent=provider.available?(provider.capabilities.desktop || provider.id==='codex'?'已连接':'入口可用'):'未连接';
    for(const node of box.querySelectorAll('.desktop-launch,.desktop-launch-help'))node.hidden=provider.available;
    box.querySelector('.provider-description').textContent=provider.id==='doubaoDesktop'?provider.detail:provider.available&&provider.capabilities.desktop?(provider.id==='antigravityDesktop'?'使用当前桌面账号，支持新建对话、上下文续接与任务状态监控。':'使用当前桌面账号和本地对话，模型与权限沿用客户端设置。'):provider.detail;
    const verification=box.querySelector('.provider-verification');verification.className='provider-verification '+(provider.available?provider.verification?.status || '':'');verification.textContent=provider.verification?(provider.verification.status==='verified'?(provider.available?'上次真实运行验证通过':'历史测试曾通过；当前未连接，请重新检测。'):'上次测试未通过：'+provider.verification.error):provider.id==='codex'?'任务的实际结果会记录在运行记录中。':'测试发送会先检测连接，再发送一条测试消息并等待回复。';
  }
}
