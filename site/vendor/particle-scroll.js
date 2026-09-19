var CanvasUIParticleScroll=(()=>{var Q=Object.defineProperty;var pe=Object.getOwnPropertyDescriptor;var ge=Object.getOwnPropertyNames;var xe=Object.prototype.hasOwnProperty;var Ee=(d,c)=>{for(var l in c)Q(d,l,{get:c[l],enumerable:!0})},Te=(d,c,l,v)=>{if(c&&typeof c=="object"||typeof c=="function")for(let s of ge(c))!xe.call(d,s)&&s!==l&&Q(d,s,{get:()=>c[s],enumerable:!(v=pe(c,s))||v.enumerable});return d};var Re=d=>Te(Q({},"__esModule",{value:!0}),d);var De={};Ee(De,{createParticleScroll:()=>Pe,supportsHtmlInCanvas:()=>_e});var Me={point:.68,band:420,density:2,size:1.25,spread:220,gravity:.35,drift:.7,swirl:60,stagger:.7,fade:.85,settle:1.2,smoothing:.6},me=`
float hash (vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}`,Se=`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main () {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`,be=`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform sampler2D uRowTex;
uniform vec2 uRes;
uniform float uDensity;
uniform float uRowCount;
uniform float uStagger;
uniform float uMaxX;
uniform float uCover;
uniform float uScroll;
uniform float uWinStart;
uniform vec3 uBg;
${me}
void main () {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  vec2 cell = floor(vec2(px.x, px.y + uScroll) / uDensity);
  float h1 = hash(cell);
  float d = h1 * uStagger;
  int row = int(clamp(cell.y - uWinStart, 0.0, uRowCount - 1.0));
  float p = texelFetch(uRowTex, ivec2(row, 0), 0).r;
  float t = clamp((p - d) / max(1.0 - d, 1e-3), 0.0, 1.0);
  float vis = step(0.9995, t) * step(px.x, uMaxX * uRes.x);
  vec4 tex = texture(uContent, vec2(vUv.x, 1.0 - vUv.y));
  outColor = vec4(mix(uBg, tex.rgb, vis * tex.a), uCover);
}`,Ae=`#version 300 es
precision highp float;
uniform sampler2D uRowTex;
uniform vec2 uRes;
uniform vec2 uGrid;
uniform float uDensity;
uniform float uStagger;
uniform float uSpread;
uniform float uGravity;
uniform float uDrift;
uniform float uSwirl;
uniform float uTime;
uniform float uFade;
uniform float uSize;
uniform float uDpr;
uniform float uMaxX;
uniform float uLag;
uniform float uScroll;
uniform float uWinStart;
out vec2 vCenter;
out float vSize;
out float vAlpha;
out float vLod;
out float vMerge;
${me}
void main () {
  float fid = float(gl_VertexID);
  vec2 local = vec2(mod(fid, uGrid.x), floor(fid / uGrid.x));
  vec2 cell = vec2(local.x, local.y + uWinStart);
  float h1 = hash(cell);
  float h2 = hash(cell + vec2(1.7, 9.1));
  float h3 = hash(cell + vec2(5.5, 2.9));
  float h4 = hash(cell + vec2(8.4, 4.2));
  float d = h1 * uStagger;
  vec2 home = vec2(
    (cell.x + 0.5) * uDensity,
    (cell.y + 0.5) * uDensity - uScroll
  );
  int row = int(clamp(local.y, 0.0, uGrid.y - 1.0));
  float p = texelFetch(uRowTex, ivec2(row, 0), 0).r;
  float t = clamp((p - d) / max(1.0 - d, 1e-3), 0.0, 1.0);
  float e = 1.0 - pow(1.0 - t, 3.0);
  float vis = (1.0 - step(0.9995, t))
    * step(home.x, uMaxX * uRes.x)
    * step(home.y, uRes.y)
    * step(-uDensity, home.y);
  if (vis < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vCenter = vec2(0.0);
    vSize = 0.0;
    vAlpha = 0.0;
    vLod = 0.0;
    vMerge = 0.0;
    return;
  }
  vec2 dir = normalize(vec2(h2 - 0.5, h3 - 0.5) + vec2(1e-4, 0.0));
  float reach = 0.08 + 0.92 * pow(h4, 2.4);
  vec2 off = dir * uSpread * reach;
  off.y += uGravity * uSpread * (0.25 + 0.75 * h4);
  vec2 scat = home + off;
  vec2 pos = mix(scat, home, e);
  vec2 perp = vec2(-dir.y, dir.x);
  pos += perp * (h2 - 0.5) * 2.0 * uSwirl * sin(e * 3.14159);
  float tt = uTime * uDrift;
  float amp = (1.0 - e) * (uSpread * 0.05 + 2.5);
  pos += vec2(
    sin(tt * (4.0 + 5.0 * h2) + h3 * 40.0),
    cos(tt * (3.5 + 5.5 * h3) + h2 * 40.0)
  ) * amp;
  pos.y += uLag * (1.0 - e) * (0.5 + 0.5 * h4);
  pos += vec2(h4 - 0.5, h1 - 0.5) * uDensity * 3.0
    * (1.0 - smoothstep(0.5, 0.85, t));
  float grow = smoothstep(0.55, 1.0, e);
  float sizeCss = mix(uSize, uDensity * 1.3, grow);
  vCenter = home;
  vSize = sizeCss;
  vAlpha = mix(uFade, 1.0, e);
  vLod = (1.0 - e) * 1.5;
  vMerge = smoothstep(0.75, 0.97, t);
  gl_Position = vec4(
    pos.x / uRes.x * 2.0 - 1.0,
    1.0 - pos.y / uRes.y * 2.0,
    0.0,
    1.0
  );
  gl_PointSize = max(sizeCss * uDpr, 1.0);
}`,ye=`#version 300 es
precision highp float;
uniform sampler2D uContent;
uniform vec2 uRes;
in vec2 vCenter;
in float vSize;
in float vAlpha;
in float vLod;
in float vMerge;
out vec4 outColor;
void main () {
  vec2 o = gl_PointCoord - 0.5;
  vec2 uv = clamp((vCenter + o * vSize) / uRes, 0.0, 1.0);
  vec4 tex = textureLod(uContent, uv, vLod);
  float circle = 1.0 - smoothstep(0.25, 0.5, length(o));
  float mask = mix(circle, 1.0, vMerge);
  float a = vAlpha * mask * tex.a;
  if (a < 0.01) discard;
  outColor = vec4(tex.rgb, a);
}`;function _e(){if(typeof document>"u")return!1;let d=document.createElement("canvas"),c=d.getContext("2d");return!!(c&&typeof c.drawElementImage=="function"&&typeof d.requestPaint=="function")}function Pe(d,c={}){let l={...Me,...c},{source:v,content:s,output:u}=d,e=u.getContext("webgl2",{alpha:!0,depth:!1,stencil:!1,antialias:!1,premultipliedAlpha:!1});if(!e||e.isContextLost())return null;let U=v.getContext("2d"),y=v,R=!!(U&&typeof U.drawElementImage=="function"&&typeof y.requestPaint=="function"),I=!1,$=()=>{};R&&(y.onpaint=()=>{try{U.reset(),U.drawElementImage(s,0,0),I=!0,$()}catch{}});function Z(n,r){let t=e.createShader(n);return e.shaderSource(t,r),e.compileShader(t),e.getShaderParameter(t,e.COMPILE_STATUS)||console.error("ParticleScroll shader error:",e.getShaderInfoLog(t)),t}function J(n,r){let t=Z(e.VERTEX_SHADER,n),i=Z(e.FRAGMENT_SHADER,r),o=e.createProgram();e.attachShader(o,t),e.attachShader(o,i),e.linkProgram(o);let m={},E=e.getProgramParameter(o,e.ACTIVE_UNIFORMS);for(let p=0;p<E;p++){let T=e.getActiveUniform(o,p);m[T.name]=e.getUniformLocation(o,T.name)}return{program:o,vert:t,frag:i,uniforms:m}}let f=J(Se,be),a=J(Ae,ye),L=e.createVertexArray();e.bindVertexArray(L);let K=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,K),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0);let ee=e.createVertexArray(),X=e.createTexture();e.bindTexture(e.TEXTURE_2D,X),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,1,1,0,e.RGBA,e.UNSIGNED_BYTE,new Uint8Array([0,0,0,0])),e.generateMipmap(e.TEXTURE_2D);let B=1,F=e.createTexture();e.bindTexture(e.TEXTURE_2D,F),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE);let _=new Float32Array(0),P=new Float32Array(0),W=!1,z=!1,D=[0,0,0],H=document.createElement("canvas");H.width=H.height=1;let C=H.getContext("2d",{willReadFrequently:!0});function te(){if(!C)return;let n=s;for(;n;){let r=getComputedStyle(n).backgroundColor;if(r&&r!=="transparent"){C.clearRect(0,0,1,1),C.fillStyle=r,C.fillRect(0,0,1,1);let[t,i,o,m]=C.getImageData(0,0,1,1).data;if(m>0){D=[t/255,i/255,o/255];return}}n=n.parentElement}D=[0,0,0]}function V(){let n=Math.min(window.devicePixelRatio||1,2),r=Math.max(1,Math.round(u.clientWidth*n)),t=Math.max(1,Math.round(u.clientHeight*n));if((u.width!==r||u.height!==t)&&(u.width=r,u.height=t),B=Math.min(1,Math.max(.05,s.clientWidth/Math.max(u.clientWidth,1))),R){let i=Math.max(1,Math.round(v.clientWidth)),o=Math.max(1,Math.round(v.clientHeight));(v.width!==i*n||v.height!==o*n)&&(v.width=i*n,v.height=o*n),y.requestPaint()}}let G=window.matchMedia("(prefers-reduced-motion: reduce)"),A=G.matches,re=0,w=!1,oe=0,ne=!1,b=s.scrollTop;V(),te();function he(){!R||!I||(I=!1,ne=!0,te(),e.bindTexture(e.TEXTURE_2D,X),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,v),e.generateMipmap(e.TEXTURE_2D))}function ae(n){if(A||!w)return 1;let r=Math.max(u.clientHeight,1),t=Math.max(l.band,1),i=s.scrollHeight-s.clientHeight,o=Math.min(Math.max(l.point,0),1)*r;if(i<=1)o=r+t;else{let E=Math.min(Math.max((b-(i-r*.5))/(r*.5),0),1);o+=(r+t-o)*E*E}let m=n-b;return Math.min(Math.max((o+t-m)/t,0),1)}function de(n,r,t,i){let o=Math.max(1,Math.ceil(s.scrollHeight/r));if(_.length!==o){let h=new Float32Array(o);for(let g=0;g<o;g++)h[g]=ae((g+.5)*r);_=h}P.length!==i&&(P=new Float32Array(i)),W=!1;let m=1,E=Math.max(l.settle,.05);for(let h=0;h<o;h++){let g=ae((h+.5)*r),x=_[h],ce=h>=t-4&&h<t+i+4;x!==g&&(A||!ce?x=g:(x<g?x=Math.min(x+n/E,g):x=Math.max(x-n/(E*.6),g),x!==g&&(W=!0)),_[h]=x),ce&&x<m&&(m=x)}z=m>=.9995,P.fill(1);let p=Math.min(Math.max(t,0),o),T=Math.min(t+i,o);T>p&&P.set(_.subarray(p,T),p-t),e.bindTexture(e.TEXTURE_2D,F),e.texImage2D(e.TEXTURE_2D,0,e.R32F,i,1,0,e.RED,e.FLOAT,P)}function ve(n){he();let r=Math.max(u.clientWidth,1),t=Math.max(u.clientHeight,1),i=u.width/r,o=Math.max(Math.max(l.density,1),Math.sqrt(r*t/8e5)),m=s.scrollTop,E=Math.ceil(r/o),p=Math.floor(m/o),T=Math.ceil(t/o)+2,h=Math.min(Math.max(l.stagger,0),.95);de(n,o,p,T),e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,u.width,u.height),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D,F),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,X),e.disable(e.BLEND),e.useProgram(f.program),e.bindVertexArray(L),e.uniform1i(f.uniforms.uContent,0),e.uniform1i(f.uniforms.uRowTex,1),e.uniform2f(f.uniforms.uRes,r,t),e.uniform1f(f.uniforms.uDensity,o),e.uniform1f(f.uniforms.uRowCount,T),e.uniform1f(f.uniforms.uStagger,h),e.uniform1f(f.uniforms.uMaxX,B),e.uniform1f(f.uniforms.uCover,R?1:0),e.uniform1f(f.uniforms.uScroll,m),e.uniform1f(f.uniforms.uWinStart,p),e.uniform3f(f.uniforms.uBg,D[0],D[1],D[2]),e.drawArrays(e.TRIANGLE_STRIP,0,4),!(!R||z)&&(e.enable(e.BLEND),e.blendFuncSeparate(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA,e.ZERO,e.ONE),e.useProgram(a.program),e.bindVertexArray(ee),e.uniform1i(a.uniforms.uRowTex,1),e.uniform2f(a.uniforms.uRes,r,t),e.uniform2f(a.uniforms.uGrid,E,T),e.uniform1f(a.uniforms.uDensity,o),e.uniform1f(a.uniforms.uStagger,h),e.uniform1f(a.uniforms.uSpread,Math.max(l.spread,0)),e.uniform1f(a.uniforms.uGravity,Math.min(Math.max(l.gravity,-1),1)),e.uniform1f(a.uniforms.uDrift,Math.max(l.drift,0)),e.uniform1f(a.uniforms.uSwirl,Math.max(l.swirl,0)),e.uniform1f(a.uniforms.uTime,re),e.uniform1f(a.uniforms.uFade,Math.min(Math.max(l.fade,0),1)),e.uniform1f(a.uniforms.uSize,Math.max(l.size,.5)),e.uniform1f(a.uniforms.uDpr,i),e.uniform1f(a.uniforms.uMaxX,B),e.uniform1i(a.uniforms.uContent,0),e.uniform1f(a.uniforms.uLag,M),e.uniform1f(a.uniforms.uScroll,m),e.uniform1f(a.uniforms.uWinStart,p),e.drawArrays(e.POINTS,0,E*T),e.bindVertexArray(L),e.disable(e.BLEND))}let q=0,k=performance.now(),Y=!1,O=!1,N=!0,M=0,ie=s.scrollTop;function le(n){if(Y)return;if(!N){O=!1;return}let r=Math.min((n-k)/1e3,1/30);k=n,re+=r;let t=s.scrollTop;M+=t-ie,ie=t,M*=Math.exp(-r/.22),M=Math.min(Math.max(M,-400),400),(A||Math.abs(M)<.1)&&(M=0),w||(A||!R?w=!0:ne&&(oe+=r,oe>=1&&(w=!0)));let i=l.smoothing,o=A||i<=0?1:1-Math.exp(-r/Math.max(i,1e-4));if(b+=(t-b)*o,Math.abs(t-b)<.5&&(b=t),ve(r),!I&&b===t&&!W&&z&&w&&M===0){O=!1;return}q=requestAnimationFrame(le)}function S(){Y||O||!N||(O=!0,k=performance.now(),q=requestAnimationFrame(le))}$=S,S();function se(){R&&y.requestPaint(),S()}s.addEventListener("scroll",se,{passive:!0});function ue(){A=G.matches,S()}G.addEventListener("change",ue);let j=new ResizeObserver(()=>{V(),S()});j.observe(u),j.observe(s);let fe=new IntersectionObserver(n=>{N=n[n.length-1]?.isIntersecting??!0,N&&S()});return fe.observe(u),{setOptions(n){Object.entries(n).some(([r,t])=>l[r]!==t)&&(Object.assign(l,n),S())},resize(){V(),S()},destroy(){Y=!0,cancelAnimationFrame(q),s.removeEventListener("scroll",se),j.disconnect(),fe.disconnect(),G.removeEventListener("change",ue),e.deleteTexture(X),e.deleteTexture(F),e.deleteProgram(f.program),e.deleteProgram(a.program),e.deleteShader(f.vert),e.deleteShader(f.frag),e.deleteShader(a.vert),e.deleteShader(a.frag),e.deleteBuffer(K),e.deleteVertexArray(L),e.deleteVertexArray(ee),R&&(y.onpaint=null)}}}return Re(De);})();
