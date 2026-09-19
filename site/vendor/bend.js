var CanvasUIBend=(()=>{var At=Object.defineProperty;var he=Object.getOwnPropertyDescriptor;var de=Object.getOwnPropertyNames;var pe=Object.prototype.hasOwnProperty;var ve=(f,m)=>{for(var i in m)At(f,i,{get:m[i],enumerable:!0})},xe=(f,m,i,c)=>{if(m&&typeof m=="object"||typeof m=="function")for(let s of de(m))!pe.call(f,s)&&s!==i&&At(f,s,{get:()=>m[s],enumerable:!(c=he(m,s))||c.enumerable});return f};var be=f=>xe(At({},"__esModule",{value:!0}),f);var we={};ve(we,{createBend:()=>Pe,supportsHtmlInCanvas:()=>Me});function ae(f){let m=f.getBoundingClientRect(),i=()=>{m=f.getBoundingClientRect()},c=new ResizeObserver(i);return c.observe(f),window.addEventListener("resize",i,{passive:!0}),window.addEventListener("scroll",i,{capture:!0,passive:!0}),{get current(){return m},destroy(){c.disconnect(),window.removeEventListener("resize",i),window.removeEventListener("scroll",i,!0)}}}var ge={zone:240,angle:80,rounding:150,perspective:700,direction:"in",ease:240,smoothing:.1,top:!0,bottom:!0,tumble:.5,tilt:.5,interactionRotation:0},ye=`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main () {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`,Ee=`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform float uZone;
uniform float uAngle;
uniform float uPersp;
uniform float uDir;
uniform float uTopAmt;
uniform float uBotAmt;
uniform float uMaxX;
uniform float uPxY;
uniform float uPxX;
uniform float uCover;
uniform vec3 uBg;
uniform float uTiltX;
uniform float uTiltY;
uniform float uPhi;
uniform float uRound;

vec3 foldEdge (float sy, float amt) {
  float yf = 1.0 - uZone;
  if (amt < 1e-4) return vec3(sy, 0.0, 1.0);
  float theta = uAngle * amt;
  if (uRound < 1e-4) {
    float s = sin(theta) * uDir;
    float c = cos(theta);
    float denom = max(c * uPersp + s * (0.5 - sy), 1e-5);
    float tRaw = uPersp * (sy - yf) / denom;
    float t = clamp(tRaw, 0.0, uZone);
    float z = max(t * s, -0.85 * uPersp);
    float alpha = 1.0 - smoothstep(uZone, uZone + 2.0 * uPxY, tRaw);
    return vec3(yf + t, z, alpha);
  }
  if (sy <= yf) return vec3(sy, 0.0, 1.0);
  float R = min(uRound, uZone);
  float r = R / theta;
  float ca = cos(theta);
  float sa = sin(theta);
  float yA = r * sa;
  float zA = r * (1.0 - ca);
  float prevSy = yf;
  float prevZ = 0.0;
  float prevU = 0.0;
  float bestU = -1.0;
  float bestZ = 0.0;
  float maxSy = yf;
  float du = uZone / 40.0;
  for (int i = 1; i <= 40; i++) {
    float u = du * float(i);
    float Y;
    float Zm;
    if (u <= R) {
      float a = u / r;
      Y = r * sin(a);
      Zm = r * (1.0 - cos(a));
    } else {
      Y = yA + (u - R) * ca;
      Zm = zA + (u - R) * sa;
    }
    Y += yf;
    float Z = max(Zm * uDir, -0.85 * uPersp);
    float scr = 0.5 + (Y - 0.5) * uPersp / (uPersp + Z);
    if ((prevSy - sy) * (scr - sy) <= 0.0 && abs(scr - prevSy) > 1e-7) {
      float f = clamp((sy - prevSy) / (scr - prevSy), 0.0, 1.0);
      bestU = mix(prevU, u, f);
      bestZ = mix(prevZ, Z, f);
      if (uDir > 0.0) break;
    }
    maxSy = max(maxSy, scr);
    prevSy = scr;
    prevZ = Z;
    prevU = u;
  }
  if (bestU < 0.0) {
    float alpha = 1.0 - smoothstep(maxSy - uPxY, maxSy + uPxY, sy);
    return vec3(1.0, prevZ, alpha);
  }
  return vec3(yf + bestU, bestZ, 1.0);
}

vec2 tipPlane (float sy, float phi) {
  float s = sin(phi);
  float c = cos(phi);
  float denom = max(c * uPersp + s * (sy - 0.5), 1e-4);
  float t = uPersp * (1.0 - sy) / denom;
  return vec2(1.0 - t, t * s);
}

void main () {
  vec2 uv = vUv;
  float cx = uMaxX * 0.5;
  float zSum = 0.0;

  if (abs(uPhi) > 1e-4) {
    if (uPhi > 0.0) {
      vec2 r = tipPlane(uv.y, uPhi);
      uv.y = r.x;
      zSum += r.y;
    } else {
      vec2 r = tipPlane(1.0 - uv.y, -uPhi);
      uv.y = 1.0 - r.x;
      zSum += r.y;
    }
  }

  float zG = uTiltX * (uv.x - cx) + uTiltY * (uv.y - 0.5);
  zSum += zG;
  uv.y = 0.5 + (uv.y - 0.5) * (uPersp + zG) / uPersp;

  float inTop = step(1.0 - uZone, uv.y);
  float inBot = step(uv.y, uZone);

  vec3 top = foldEdge(uv.y, uTopAmt);
  vec3 bot = foldEdge(1.0 - uv.y, uBotAmt);

  float srcY = uv.y;
  srcY = mix(srcY, top.x, inTop);
  srcY = mix(srcY, 1.0 - bot.x, inBot);

  zSum += inTop * top.y + inBot * bot.y;
  float alpha = mix(1.0, top.z, inTop) * mix(1.0, bot.z, inBot);

  float srcX = cx + (uv.x - cx) * (uPersp + zSum) / uPersp;

  alpha *= smoothstep(-2.0 * uPxX, 0.0, srcX);
  alpha *= 1.0 - smoothstep(uMaxX, uMaxX + 2.0 * uPxX, srcX);
  alpha *= smoothstep(-2.0 * uPxY, 0.0, srcY);
  alpha *= 1.0 - smoothstep(1.0, 1.0 + 2.0 * uPxY, srcY);

  vec2 p = vec2(
    clamp(srcX, 0.0005, uMaxX - 0.0005),
    clamp(srcY, 0.0005, 0.9995)
  );
  vec4 base = texture(uContent, vec2(p.x, 1.0 - p.y));

  outColor = vec4(mix(uBg, base.rgb, alpha * base.a), uCover);
}`;function Me(){if(typeof document>"u")return!1;let f=document.createElement("canvas"),m=f.getContext("2d");return!!(m&&typeof m.drawElementImage=="function"&&typeof f.requestPaint=="function")}var Ct="data-canvasui-hover",z="data-canvasui-content",j="data-canvasui-cursor",Re=`:is([${Ct}], :hover:where(:not([${z}], [${z}] *)))`;function Te(){if(typeof document>"u"||document.documentElement.dataset.canvasuiHoverRules==="")return;document.documentElement.dataset.canvasuiHoverRules="";let f=i=>{for(let c of Array.from(i))if(c instanceof CSSStyleRule){if(c.selectorText.includes(":hover"))try{c.selectorText=c.selectorText.replace(/:hover\b/g,Re)}catch{}c.cssRules.length&&f(c.cssRules)}else if("cssRules"in c)try{f(c.cssRules)}catch{}};for(let i of Array.from(document.styleSheets))try{f(i.cssRules)}catch{}let m=document.createElement("style");m.textContent=`[${z}][${j}], [${z}][${j}] * { cursor: var(--canvasui-cursor) !important; }`,document.head.appendChild(m)}function Pe(f,m={}){let i={...ge,...m},{source:c,content:s,output:l}=f,e=l.getContext("webgl2",{alpha:!0,depth:!1,stencil:!1,antialias:!1,premultipliedAlpha:!1});if(!e||e.isContextLost())return null;let Q=c.getContext("2d"),F=c,g=!!(Q&&typeof Q.drawElementImage=="function"&&typeof F.requestPaint=="function"),J=!1,St=()=>{};g&&(F.onpaint=()=>{try{Q.reset(),Q.drawElementImage(s,0,0),J=!0,St()}catch{}});function Xt(t,o){let n=e.createShader(t);return e.shaderSource(n,o),e.compileShader(n),e.getShaderParameter(n,e.COMPILE_STATUS)||console.error("Bend shader error:",e.getShaderInfoLog(n)),n}let Lt=Xt(e.VERTEX_SHADER,ye),Yt=Xt(e.FRAGMENT_SHADER,Ee),R=e.createProgram();e.attachShader(R,Lt),e.attachShader(R,Yt),e.linkProgram(R);let d={},ie=e.getProgramParameter(R,e.ACTIVE_UNIFORMS);for(let t=0;t<ie;t++){let o=e.getActiveUniform(R,t);d[o.name]=e.getUniformLocation(R,o.name)}let Ut=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,Ut),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0);let tt=e.createTexture();e.bindTexture(e.TEXTURE_2D,tt),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,1,1,0,e.RGBA,e.UNSIGNED_BYTE,new Uint8Array([0,0,0,0])),e.generateMipmap(e.TEXTURE_2D);let et=1,Z=[0,0,0],mt=document.createElement("canvas");mt.width=mt.height=1;let H=mt.getContext("2d",{willReadFrequently:!0});function _t(){if(!H)return;let t=s;for(;t;){let o=getComputedStyle(t).backgroundColor;if(o&&o!=="transparent"){H.clearRect(0,0,1,1),H.fillStyle=o,H.fillRect(0,0,1,1);let[n,a,r,u]=H.getImageData(0,0,1,1).data;if(u>0){Z=[n/255,a/255,r/255];return}}t=t.parentElement}Z=[0,0,0]}function ht(){let t=Math.min(window.devicePixelRatio||1,2),o=Math.max(1,Math.round(l.clientWidth*t)),n=Math.max(1,Math.round(l.clientHeight*t));if((l.width!==o||l.height!==n)&&(l.width=o,l.height=n),et=Math.min(1,Math.max(.05,s.clientWidth/Math.max(l.clientWidth,1))),g){let a=Math.max(1,Math.round(c.clientWidth)),r=Math.max(1,Math.round(c.clientHeight));(c.width!==a*t||c.height!==r*t)&&(c.width=a*t,c.height=r*t),F.requestPaint()}}let O=0,G=0,w=0,A=0,E=0,y=0,C=0,S=0,X=0,L=0;function N(){let t=s.scrollHeight-s.clientHeight,o=s.scrollTop,n=Math.max(i.ease,1),a=r=>{let u=Math.min(Math.max(r/n,0),1);return u*u*(3-2*u)};O=t>1&&i.top?a(o):0,G=t>1&&i.bottom?a(t-o):0}ht(),N(),_t();function se(){!g||!J||(J=!1,_t(),e.bindTexture(e.TEXTURE_2D,tt),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,c),e.generateMipmap(e.TEXTURE_2D))}function ue(){se();let t=Math.max(l.clientHeight,1),o=Math.max(l.clientWidth,1),n=Math.min(Math.max(i.zone,8)/t,.49);e.useProgram(R),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,tt),e.uniform1i(d.uContent,0),e.uniform1f(d.uZone,n),e.uniform1f(d.uAngle,Math.min(Math.max(i.angle,1),160)*(Math.PI/180)),e.uniform1f(d.uPersp,Math.max(i.perspective,50)/t),e.uniform1f(d.uDir,i.direction==="in"?-1:1),e.uniform1f(d.uTopAmt,w),e.uniform1f(d.uBotAmt,A),e.uniform1f(d.uMaxX,et),e.uniform1f(d.uPxY,1.5/t),e.uniform1f(d.uPxX,1.5/o),e.uniform1f(d.uCover,g?1:0),e.uniform3f(d.uBg,Z[0],Z[1],Z[2]),e.uniform1f(d.uTiltX,X),e.uniform1f(d.uTiltY,L),e.uniform1f(d.uPhi,y),e.uniform1f(d.uRound,Math.min(Math.max(i.rounding,0)/t,n)),e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,l.width,l.height),e.drawArrays(e.TRIANGLE_STRIP,0,4)}let dt=0,pt=performance.now(),vt=!1,nt=!1,ot=!0,rt=window.matchMedia("(prefers-reduced-motion: reduce)"),U=rt.matches;function Bt(t){if(vt)return;if(!ot){nt=!1;return}let o=Math.min((t-pt)/1e3,1/30);pt=t;let n=i.smoothing,a=U||n<=0?1:1-Math.exp(-o/Math.max(n,1e-4));w+=(O-w)*a,A+=(G-A)*a,Math.abs(O-w)<.001&&(w=O),Math.abs(G-A)<.001&&(A=G),E*=Math.exp(-o/.22),Math.abs(E)<.5&&(E=0);let r=U||i.tumble<=0?0:Math.tanh(E/500)*.4*Math.min(i.tumble,1);y+=(r-y)*Math.min(o/.09,1),r===0&&Math.abs(y)<1e-4&&(y=0),(U||i.tilt<=0)&&(C=0,S=0);let u=Math.min(o/.15,1);if(X+=(C-X)*u,L+=(S-L)*u,Math.abs(C-X)<1e-4&&(X=C),Math.abs(S-L)<1e-4&&(L=S),ue(),!J&&w===O&&A===G&&E===0&&y===0&&X===C&&L===S){nt=!1;return}dt=requestAnimationFrame(Bt)}function x(){vt||nt||!ot||(nt=!0,pt=performance.now(),dt=requestAnimationFrame(Bt))}St=x,x();function Dt(){N(),g&&F.requestPaint(),bt&&Wt(Gt,Nt),x()}s.addEventListener("scroll",Dt,{passive:!0});function It(t){if(i.tumble<=0||U)return;let o=s.scrollHeight-s.clientHeight;if(o<=1)return;let n=s.scrollTop;if(t.deltaY>0&&n>=o-1)E=Math.min(E+t.deltaY,900);else if(t.deltaY<0&&n<=1)E=Math.max(E+t.deltaY,-900);else return;x()}s.addEventListener("wheel",It,{passive:!0});let zt=ae(l);function Ft(t){if(t.isPrimary&&(Gt=t.clientX,Nt=t.clientY,bt=!0,Wt(t.clientX,t.clientY),i.tilt>0&&!U)){let o=zt.current;if(o.width>0&&o.height>0){let n=(t.clientX-o.left)/o.width-.5,a=.5-(t.clientY-o.top)/o.height,r=Math.min(i.tilt,1)*.14;C=-n*r,S=-a*r,x()}}}s.addEventListener("pointermove",Ft,{passive:!0});function Zt(){bt=!1,it(null),C=0,S=0,x()}s.addEventListener("pointerleave",Zt);function xt(t,o){let n=Math.max(l.clientWidth,1),a=Math.max(l.clientHeight,1),r=Math.max(i.perspective,50)/a,u=Math.min(Math.max(i.zone,8)/a,.49),p=Math.min(Math.max(i.rounding,0)/a,u),ce=Math.min(Math.max(i.angle,1),160)*(Math.PI/180),Mt=i.direction==="in"?-1:1,Rt=et*.5,te=t/n,v=1-o/a,_=0;if(Math.abs(y)>1e-4){let h=(b,M)=>{let T=Math.sin(M),B=Math.cos(M),Y=Math.max(B*r+T*(b-.5),1e-4),k=r*(1-b)/Y;return[1-k,k*T]};if(y>0){let b=h(v,y);v=b[0],_+=b[1]}else{let b=h(1-v,-y);v=1-b[0],_+=b[1]}}let ee=X*(te-Rt)+L*(v-.5);_+=ee,v=.5+(v-.5)*((r+ee)/r);let ne=(h,b)=>{let M=1-u;if(b<1e-4)return[h,0,1];let T=ce*b;if(p<1e-4){let D=Math.sin(T)*Mt,P=Math.cos(T),K=Math.max(P*r+D*(.5-h),1e-5),I=r*(h-M)/K,lt=Math.min(Math.max(I,0),u),$=Math.max(lt*D,-.85*r);return[M+lt,$,I>u?0:1]}if(h<=M)return[h,0,1];let B=Math.min(p,u),Y=B/T,k=Math.cos(T),oe=Math.sin(T),le=Y*oe,fe=Y*(1-k),q=M,ct=0,Pt=0,wt=-1,re=0,me=u/40;for(let D=1;D<=40;D++){let P=me*D,K,I;if(P<=B){let V=P/Y;K=Y*Math.sin(V),I=Y*(1-Math.cos(V))}else K=le+(P-B)*k,I=fe+(P-B)*oe;let lt=M+K,$=Math.max(I*Mt,-.85*r),ft=.5+(lt-.5)*r/(r+$);if((q-h)*(ft-h)<=0&&Math.abs(ft-q)>1e-7){let V=Math.min(Math.max((h-q)/(ft-q),0),1);if(wt=Pt+(P-Pt)*V,re=ct+($-ct)*V,Mt>0)break}q=ft,ct=$,Pt=P}return wt<0?[1,ct,0]:[M+wt,re,1]},W=v,ut=1;if(v>=1-u){let h=ne(v,w);W=h[0],_+=h[1],ut*=h[2]}else if(v<=u){let h=ne(1-v,A);W=1-h[0],_+=h[1],ut*=h[2]}let Tt=Rt+(te-Rt)*((r+_)/r);return(Tt<0||Tt>et||W<0||W>1)&&(ut=0),{x:Tt*n,y:(1-W)*a,alpha:ut}}let at=!1,Ht=[],Ot=null,Gt=0,Nt=0,bt=!1;g&&(Te(),s.setAttribute(z,""));function it(t){if(t===Ot)return;Ot=t;let o=new Set;for(let n=t;n&&(o.add(n),n!==s);n=n.parentElement);for(let n of Ht)o.has(n)||n.removeAttribute(Ct);for(let n of o)n.setAttribute(Ct,"");Ht=Array.from(o),s.removeAttribute(j),s.style.removeProperty("--canvasui-cursor"),t&&(s.style.setProperty("--canvasui-cursor",getComputedStyle(t).cursor),s.setAttribute(j,""))}function gt(t,o){let n=l.getBoundingClientRect(),a=Math.max(l.clientWidth,1),r=Math.max(l.clientHeight,1),u=t-n.left,p=o-n.top;return i.interactionRotation===-90?{rect:n,x:a-p/(n.height/a),y:u/(n.width/r)}:i.interactionRotation===90?{rect:n,x:p/(n.height/a),y:r-u/(n.width/r)}:{rect:n,x:u/(n.width/a),y:p/(n.height/r)}}function yt(t,o,n){let a=Math.max(l.clientWidth,1),r=Math.max(l.clientHeight,1);return i.interactionRotation===-90?{x:n.left+o*(n.width/r),y:n.top+(a-t)*(n.height/a)}:i.interactionRotation===90?{x:n.left+(r-o)*(n.width/r),y:n.top+t*(n.height/a)}:{x:n.left+t*(n.width/a),y:n.top+o*(n.height/r)}}function Wt(t,o){if(!g)return;let n=gt(t,o),{rect:a}=n;if(a.width===0||a.height===0)return;let r=xt(n.x,n.y);if(r.alpha<.5){it(null);return}let u=yt(r.x,r.y,a),p=document.elementFromPoint(u.x,u.y);it(p&&s.contains(p)?p:null)}function kt(t){if(at||!g||t.button!==0)return;let o=gt(t.clientX,t.clientY),{rect:n}=o;if(n.width===0||n.height===0)return;let a=xt(o.x,o.y);if(a.alpha<.5){t.preventDefault(),t.stopPropagation();return}let r=yt(a.x,a.y,n);if(Math.hypot(r.x-t.clientX,r.y-t.clientY)<1.5)return;t.preventDefault(),t.stopPropagation();let u=document.elementFromPoint(r.x,r.y);if(u){at=!0;try{u.dispatchEvent(new MouseEvent("click",{bubbles:!0,cancelable:!0,composed:!0,view:window,detail:t.detail,clientX:r.x,clientY:r.y,screenX:t.screenX,screenY:t.screenY,ctrlKey:t.ctrlKey,shiftKey:t.shiftKey,altKey:t.altKey,metaKey:t.metaKey,button:t.button})),u instanceof HTMLElement&&u.matches("input, textarea, select, [contenteditable]")&&u.focus()}finally{at=!1}}}s.addEventListener("click",kt,!0);function qt(t,o){let n=document;if(typeof n.caretPositionFromPoint=="function"){let r=n.caretPositionFromPoint(t,o);return r?{node:r.offsetNode,offset:r.offset}:null}let a=n.caretRangeFromPoint?.(t,o);return a?{node:a.startContainer,offset:a.startOffset}:null}function Kt(t){let o=gt(t.clientX,t.clientY),{rect:n}=o;if(n.width===0||n.height===0)return null;let a=xt(o.x,o.y);if(a.alpha<.5)return null;let r=yt(a.x,a.y,n),u=r.x,p=r.y;return Math.hypot(u-t.clientX,p-t.clientY)<1.5?null:{x:u,y:p}}let st=!1;function $t(t){if(at||!g||t.button!==0)return;let o=Kt(t);if(!o)return;t.preventDefault();let n=qt(o.x,o.y);if(!n||!s.contains(n.node))return;let a=window.getSelection();a&&(a.removeAllRanges(),a.collapse(n.node,n.offset),st=!0)}function Vt(t){if(!st)return;if(!(t.buttons&1)){st=!1;return}let o=Kt(t),n=o?qt(o.x,o.y):null,a=window.getSelection();n&&a&&a.anchorNode&&s.contains(n.node)&&a.extend(n.node,n.offset)}function jt(){st=!1}s.addEventListener("mousedown",$t,!0),window.addEventListener("mousemove",Vt,!0),window.addEventListener("mouseup",jt,!0);function Qt(){U=rt.matches,x()}rt.addEventListener("change",Qt);let Et=new ResizeObserver(()=>{ht(),N(),x()});Et.observe(l),Et.observe(s);let Jt=new IntersectionObserver(t=>{ot=t[t.length-1]?.isIntersecting??!0,ot&&x()});return Jt.observe(l),{setOptions(t){Object.entries(t).some(([o,n])=>i[o]!==n)&&(Object.assign(i,t),N(),x())},resize(){ht(),N(),x()},destroy(){vt=!0,zt.destroy(),cancelAnimationFrame(dt),it(null),s.removeAttribute(z),s.removeAttribute(j),s.removeEventListener("scroll",Dt),s.removeEventListener("wheel",It),s.removeEventListener("pointermove",Ft),s.removeEventListener("pointerleave",Zt),s.removeEventListener("click",kt,!0),s.removeEventListener("mousedown",$t,!0),window.removeEventListener("mousemove",Vt,!0),window.removeEventListener("mouseup",jt,!0),Et.disconnect(),Jt.disconnect(),rt.removeEventListener("change",Qt),e.deleteTexture(tt),e.deleteProgram(R),e.deleteShader(Lt),e.deleteShader(Yt),e.deleteBuffer(Ut),g&&(F.onpaint=null)}}}return be(we);})();
