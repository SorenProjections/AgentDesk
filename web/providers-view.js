import {$,element,api,toast} from './api.js';
let signature='';
const order=['codex','antigravityDesktop','workbuddyDesktop','antigravity','workbuddy'];
export function renderProviders(providers,refreshState){
  const next=JSON.stringify(providers || []);if(next===signature)return;signature=next;
  for(const provider of [...providers || []].sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id))){
    let box=$('provider-'+provider.id);
    if(!box){
      box=element('article','provider-setting');box.id='provider-'+provider.id;
      const heading=element('div','provider-heading');heading.append(element('span','provider-monogram '+provider.id,provider.id==='codex'?'C':provider.id.startsWith('antigravity')?'A':'W'),element('span','badge'));box.append(heading,element('h2','provider-title',provider.name),element('p','provider-kind',provider.id==='codex'?'本机 App Server':provider.capabilities.desktop?'桌面客户端':'独立命令行客户端'),element('p','provider-description'),element('p','provider-verification'));
      const buttons=element('div','provider-buttons');
      if(provider.id==='codex'){const reconnect=$('reconnect');reconnect.className='secondary';buttons.append(reconnect);}
      else{
        let binary;
        if(!provider.capabilities.desktop){binary=element('input');binary.type='text';binary.value=provider.binary || '';binary.setAttribute('aria-label',provider.name+' 程序路径');binary.placeholder='自动检测，或填写程序完整路径';box.append(binary);}
        for(const [verify,text]of [[false,'检测连接'],[true,'测试发送']]){
          const button=element('button',verify?'secondary':'primary',text);button.type='button';
          button.addEventListener('click',async()=>{
            buttons.querySelectorAll('button').forEach(b=>b.disabled=true);button.textContent=verify?'测试中…':'检测中…';
            try{const result=await api('providers/'+provider.id,'POST',{...(binary?{binary:binary.value}:{}),verify},100000);await refreshState();const verified=result.verification?.status==='verified';toast(verify?(verified?'真实发送与完成检测已验证。':result.verification?.error || result.detail):result.available?'连接已就绪。':result.detail,verify?!verified:!result.available);}
            catch(error){toast(error.message,true);}finally{buttons.querySelectorAll('button').forEach(b=>b.disabled=false);button.textContent=text;}
          });buttons.append(button);
        }
        if(provider.id==='workbuddyDesktop'){
          const launch=element('button','quiet desktop-launch','启动桌面连接');launch.type='button';launch.addEventListener('click',async()=>{launch.disabled=true;try{await api('desktop/workbuddy/launch','POST');toast('WorkBuddy 正在打开。主界面加载后，点击检测连接。');}catch(error){toast(error.message,true);}finally{launch.disabled=false;}});buttons.append(launch);
          box.append(element('p','field-help desktop-launch-help','需要启用连接时，先结束当前任务并完全退出 WorkBuddy，再从这里启动。'));
        }
      }
      box.append(buttons);(provider.capabilities.desktop || provider.id==='codex'?$('providerList'):$('cliProviderList')).append(box);
    }
    const badge=box.querySelector('.badge');badge.className='badge '+(provider.available?'completed':'paused');badge.textContent=provider.available?(provider.capabilities.desktop || provider.id==='codex'?'已连接':'入口可用'):'未连接';
    for(const node of box.querySelectorAll('.desktop-launch,.desktop-launch-help'))node.hidden=provider.available;
    box.querySelector('.provider-description').textContent=provider.available&&provider.capabilities.desktop?(provider.id==='antigravityDesktop'?'使用当前桌面账号，支持新建对话、上下文续接与任务状态监控。':'使用当前桌面账号和本地对话，模型与权限沿用客户端设置。'):provider.detail;
    const verification=box.querySelector('.provider-verification');verification.className='provider-verification '+(provider.verification?.status || '');verification.textContent=provider.verification?(provider.verification.status==='verified'?'真实运行验证通过':'上次测试未通过：'+provider.verification.error):provider.id==='codex'?'任务的实际结果会记录在运行记录中。':'连接后测试发送，确认账号和回复正常。';
  }
}
