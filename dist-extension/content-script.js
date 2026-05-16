var e=[/^\s*ruleset\s*\(\s*name\s*=/m,/^\s*input\s*\(\s*type\s*=/m,/^\s*source\s+\w+\s*\{/m,/^\s*destination\s+\w+\s*\{/m,/^\s*\[SERVICE\]/m,/^\s*\[INPUT\]/m,/^\s*<Input\s+\w+/i,/^\s*<Output\s+\w+/i,/^\s*input\s*\{[\s\S]*\}\s*filter\s*\{/m,/^\s*\[sources\.\w+\]/m,/^\s*sources\s*:\s*$/m];function t(t){if(t.length<30||t.length>2e5)return!1;let n=0;for(let r of e)r.test(t)&&n++;return n>=1}function n(e,t){if(e.dataset.logflowDecorated===`1`)return;e.dataset.logflowDecorated=`1`;let n=document.createElement(`button`);n.textContent=`Open in logflow-sim`,n.style.cssText=`
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 4px 0 6px;
    padding: 2px 8px;
    font-size: 11px;
    font-family: -apple-system, system-ui, sans-serif;
    border: 1px solid rgba(14, 165, 233, 0.6);
    border-radius: 4px;
    background: rgba(14, 165, 233, 0.08);
    color: rgb(14, 100, 160);
    cursor: pointer;
    z-index: 1;
  `,n.addEventListener(`click`,e=>{e.preventDefault(),e.stopPropagation(),chrome.storage.local.set({pendingConfig:t},()=>{chrome.runtime.sendMessage({type:`openPopup`})})}),e.parentElement?.insertBefore(n,e)}function r(){let e=document.querySelectorAll(`pre, code`);for(let r of e){let e=r.innerText;t(e)&&n(r,e)}}r(),new MutationObserver(()=>r()).observe(document.body,{childList:!0,subtree:!0});