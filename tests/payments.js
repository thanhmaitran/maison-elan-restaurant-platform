// Run twice: once on a server without Stripe keys, once with STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_test and HAS_STRIPE=1 here.
const crypto=require('crypto');const B='http://localhost:'+(process.env.PORT||3000);let fail=0;const t=(n,ok)=>{console.log((ok?'PASS ':'FAIL ')+n);if(!ok)fail++};
const call=async(m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json','X-Requested-With':'me'},body:b?JSON.stringify(b):undefined});return{s:r.status,d:await r.json()}};
(async()=>{const base={name:'P',email:'p@example.com',items:[{slug:'french-onion-soup',quantity:2}]};
 const d=await call('POST','/api/orders',{...base,service_type:'dine_in',table_number:'t-04',payment_method:'at_table'});t('dine-in order stores table T-04',d.s===200&&d.d.table_number==='T-04'&&d.d.payment_method==='at_table');
 t('invalid table refused',(await call('POST','/api/orders',{...base,service_type:'dine_in',table_number:'T-99'})).s===400);
 t('collection cannot pay at table',(await call('POST','/api/orders',{...base,payment_method:'at_table'})).s===400);
 t('pay-at-table order is unpaid',(await call('GET',`/api/orders/${d.d.order_number}?email=p@example.com`)).d.payment_status==='unpaid_at_table');
 const op=(await call('GET','/api/checkout/options')).d;t('options list tables',op.tables.length===8&&op.tables[0]==='T-01');
 if(!process.env.HAS_STRIPE){t('card refused when no provider',(await call('POST','/api/orders',{...base,payment_method:'card'})).s===400);t('options show card unavailable',op.card===false)}
 else{const o=await call('POST','/api/orders',{...base,service_type:'dine_in',table_number:'T-02',payment_method:'qr'});t('QR order awaits payment',o.s===200&&o.d.payment_method==='qr');
  const st=()=>call('GET',`/api/orders/${o.d.order_number}?email=p@example.com`).then(r=>r.d.payment_status);
  const ev=(id,amt,sig)=>{const body=JSON.stringify({id,type:'checkout.session.completed',data:{object:{id:'cs_'+id,payment_status:'paid',amount_total:amt,currency:'gbp',client_reference_id:o.d.order_number}}});const ts=Math.floor(Date.now()/1000);const v1=sig||crypto.createHmac('sha256','whsec_test').update(ts+'.'+body).digest('hex');return fetch(B+'/api/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${ts},v1=${v1}`},body}).then(async r=>({s:r.status,d:await r.json()}))};
  t('bad signature rejected',(await ev('e0',1900,'0'.repeat(64))).s===400);
  await ev('e1',1,null);t('wrong amount does not mark paid',await st()==='awaiting_payment');
  t('valid webhook marks paid',(await ev('e2',Math.round(o.d.total*100))).s===200&&await st()==='paid_online');
  t('replayed event ignored',(await ev('e2',Math.round(o.d.total*100))).d.duplicate===true)}
 console.log(fail?fail+' FAILED':'ALL PASSED');process.exit(fail?1:0)})();
