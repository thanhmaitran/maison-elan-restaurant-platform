// Run with the server up: PORT=3100 node server.js & node tests/smoke.js
const B='http://localhost:'+(process.env.PORT||3000);let fail=0;
const t=(n,ok)=>{console.log((ok?'PASS ':'FAIL ')+n);if(!ok)fail++};
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'me'},body:JSON.stringify(b)}).then(async r=>({s:r.status,d:await r.json()}));
(async()=>{
 const menu=await (await fetch(B+'/api/menu')).json();t('menu has 42 items',menu.total===42);
 t('search filters',(await (await fetch(B+'/api/menu?q=scallop')).json()).total>=1);
 const o={name:'T',email:'t@example.com',items:[{slug:'wild-mushroom-arancini',quantity:2,price:0.01}],idempotency_key:'k'+Date.now()};
 const r1=await post('/api/orders',o);t('order total from server price (2×10.50)',r1.s===200&&r1.d.total===21);
 const r2=await post('/api/orders',o);t('duplicate submit returns same order',r2.d.order_number===r1.d.order_number&&r2.d.duplicate);
 t('empty order rejected',(await post('/api/orders',{name:'T',email:'t@example.com',items:[]})).s===400);
 t('unknown dish rejected',(await post('/api/orders',{name:'T',email:'t@example.com',items:[{slug:'nope',quantity:1}]})).s===422);
 t('order lookup needs matching email',(await fetch(B+'/api/orders/'+r1.d.order_number+'?email=x@y.com')).status===404);
 let d=new Date(Date.now()+10*864e5);while(d.getUTCDay()!==6)d=new Date(+d+864e5);const date=d.toISOString().slice(0,10);
 const av=await (await fetch(`${B}/api/reservations/availability?date=${date}&party=8`)).json();t('availability returns slots',av.slots.length>0);
 const bk={name:'A',email:'a@example.com',party_size:8,date,time:av.slots[0].time};
 const a=await post('/api/reservations',bk),b=await post('/api/reservations',{...bk,name:'B',email:'b@example.com'});
 t('first booking confirmed',a.d.status==='confirmed');t('same table/time refused (409)',b.s===409);
 const mon=new Date(Date.now()+8*864e5);while(mon.getUTCDay()!==1)mon.setUTCDate(mon.getUTCDate()+1);
 t('closed day has no slots',(await (await fetch(`${B}/api/reservations/availability?date=${mon.toISOString().slice(0,10)}&party=2`)).json()).slots.length===0);
 t('contact form stores',(await post('/api/contact',{name:'T',email:'t@example.com',message:'Hello there'})).d.status==='received');
 t('path traversal blocked',!(await (await fetch(B+'/..%2f..%2fserver.js')).text()).includes('use strict'));
 console.log(fail?fail+' FAILED':'ALL PASSED');process.exit(fail?1:0)})();
