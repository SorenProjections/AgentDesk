export const $ = id => document.getElementById(id);
export function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;}
export function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','icon');svg.setAttribute('aria-hidden','true');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
let dialogSequence=0;
export function containDialogFocus(dialog){
  dialog.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const items=[...dialog.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(node=>node.tabIndex>=0&&!node.matches(':disabled')&&node.getClientRects().length);
    const first=items[0],last=items.at(-1);
    if(!first){event.preventDefault();return;}
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  });
}
export function confirmAction(message,{title='确认操作',accept='确认',danger=false}={}){
  return new Promise(resolve=>{
    const dialog=element('dialog','confirm-dialog');const heading=element('h2','',title);heading.id='confirm-title-'+(++dialogSequence);dialog.setAttribute('aria-labelledby',heading.id);
    const text=element('p','',message);const actions=element('div','confirm-actions');const cancel=element('button','secondary','取消');cancel.type='button';cancel.autofocus=true;cancel.addEventListener('click',()=>dialog.close('cancel'));
    const proceed=element('button',danger?'primary destructive':'primary',accept);proceed.type='button';proceed.addEventListener('click',()=>dialog.close('confirm'));actions.append(cancel,proceed);dialog.append(heading,text,actions);
    dialog.addEventListener('close',()=>{const accepted=dialog.returnValue==='confirm';dialog.remove();resolve(accepted);},{once:true});containDialogFocus(dialog);document.body.append(dialog);dialog.showModal();
  });
}
let toastTimer;
export function toast(message,error=false){clearTimeout(toastTimer);const node=$('toast');node.textContent=message;node.classList.toggle('error',error);node.hidden=false;if(typeof node.showPopover==='function'){node.setAttribute('popover','manual');if(!node.matches(':popover-open'))node.showPopover();}toastTimer=setTimeout(()=>{if(typeof node.hidePopover==='function'&&node.matches(':popover-open'))node.hidePopover();node.hidden=true;},error?11000:4500);}
export async function api(url,method='GET',value,timeout=55000){const options={method,credentials:'same-origin',signal:AbortSignal.timeout(timeout),headers:{'X-Scheduler-Request':'1'}};if(method!=='GET'){options.headers['Content-Type']='application/json';options.body=JSON.stringify(value || {});}const response=await fetch('/api/'+url,options);const data=await response.json();if(!response.ok)throw new Error(data.error || '操作失败。');return data;}
