const axios=require("axios");
function config(){const base=(process.env.WC_STORE_URL||"").replace(/\/$/,"");if(!base||!process.env.WC_CONSUMER_KEY||!process.env.WC_CONSUMER_SECRET)throw new Error("WooCommerce API configuration is incomplete");return{base,key:process.env.WC_CONSUMER_KEY,secret:process.env.WC_CONSUMER_SECRET};}
async function request(endpoint,method="GET",data){
 const c=config(),auth=Buffer.from(c.key+":"+c.secret).toString("base64");
 const timeout=Math.max(5000,Math.min(120000,Number(process.env.WC_API_TIMEOUT_MS)||60000));
 try{
  const response=await axios({url:`${c.base}/wp-json/wc/v3/${endpoint}`,method,data,headers:{Authorization:`Basic ${auth}`},timeout});
  return response.data;
 }catch(err){
  const detail=err.code||err.response?.status||err.message;
  console.error("WooCommerce API request failed:",{method,endpoint,code:detail,timeoutMs:timeout,baseUrl:c.base});
  throw err;
 }
}
async function listProducts(page=1,perPage=100){return request(`products?status=any&per_page=${Math.min(100,perPage)}&page=${page}`);}
async function searchCustomers(query,page=1){return request(`customers?search=${encodeURIComponent(query)}&per_page=30&page=${page}`);}
async function getCustomer(id){return request(`customers/${encodeURIComponent(id)}`);}
async function createExpenseOrder(expense){
 const payload={
  status:"on-hold",
  set_paid:false,
  billing:{first_name:"Bendemen",last_name:"Supply Panel",email:process.env.WC_EXPENSE_EMAIL||"info@bendemen.nl"},
  line_items:[],
  fee_lines:[{name:`Supply Panel kosten: ${expense.name}`,tax_status:"none",total:(expense.amount_cents/100).toFixed(2)}],
  meta_data:[{key:"_bendemen_supply_expense",value:"1"},{key:"_bendemen_expense_id",value:String(expense.id)}]
 };
 return request("orders","POST",payload);
}
async function createWooOrder(order,items){
 const line_items=[],fee_lines=[];
 for(const item of items){
  const total=(item.quantity*item.unit_price_cents/100).toFixed(2);
  const wcProductId=item.product_id&&/^\d+$/.test(String(item.product_id))?String(item.product_id):null;
  if(wcProductId){
   line_items.push({product_id:Number(wcProductId),quantity:item.quantity,subtotal:total,total});
  }else{
   fee_lines.push({name:item.quantity>1?`${item.product_name} (aantal: ${item.quantity})`:item.product_name,tax_status:"none",total});
  }
 }
 const payload={
  status:"pending",
  set_paid:false,
  customer_id:order.wc_customer_id?Number(order.wc_customer_id):0,
  billing:{email:order.customer_email,first_name:order.customer_name},
  line_items,
  fee_lines,
  meta_data:[{key:"_bendemen_supply_panel_order",value:"1"},{key:"_bendemen_local_order_id",value:String(order.id)}]
 };
 return request("orders","POST",payload);
}
async function updateWooOrder(wcOrderId,items){
 const existing=await request(`orders/${encodeURIComponent(wcOrderId)}`);
 const line_items=[],fee_lines=[];
 for(const item of items){
  const total=(item.quantity*item.unit_price_cents/100).toFixed(2);
  const wcProductId=item.product_id&&/^\\d+$/.test(String(item.product_id))?String(item.product_id):null;
  if(wcProductId){
   const match=(existing.line_items||[]).find(line=>String(line.product_id)===wcProductId);
   line_items.push({...(match?{id:match.id}:{}),product_id:Number(wcProductId),quantity:item.quantity,subtotal:total,total});
  }else{
   const name=item.quantity>1?`${item.product_name} (aantal: ${item.quantity})`:item.product_name;
   const match=(existing.fee_lines||[]).find(line=>line.name===name);
   fee_lines.push({...(match?{id:match.id}:{}),name,tax_status:"none",total});
  }
 }
 return request(`orders/${encodeURIComponent(wcOrderId)}`,"PUT",{line_items,fee_lines});
}
async function createWooSubscription(subscription,items){
 const line_items=[],fee_lines=[];
 for(const item of items){
  const wcProductId=item.product_id&&/^\d+$/.test(String(item.product_id))?String(item.product_id):null;
  if(wcProductId)line_items.push({product_id:Number(wcProductId),quantity:item.quantity});
  else fee_lines.push({name:item.quantity>1?`${item.product_name} (aantal: ${item.quantity})`:item.product_name,tax_status:"none",total:(item.quantity*item.unit_price_cents/100).toFixed(2)});
 }
 if(!line_items.length&&!fee_lines.length)throw new Error("Abonnement bevat geen regels.");
 const payload={status:"pending",customer_id:subscription.wc_customer_id?Number(subscription.wc_customer_id):0,billing:{email:subscription.customer_email,first_name:subscription.customer_name},billing_period:subscription.interval==="year"?"year":subscription.interval==="week"?"week":"month",billing_interval:1,start_date:subscription.next_payment||new Date().toISOString().slice(0,10),line_items,fee_lines,meta_data:[{key:"_bendemen_supply_panel_subscription",value:"1"},{key:"_bendemen_local_subscription_id",value:String(subscription.id)}]};
 return request("subscriptions","POST",payload);
}
async function refreshWooOrder(localOrderId){return null;}
async function getInvoicePdf(wcOrderId){
 const c=config();
 if(!process.env.WPO_WCPDF_API_TOKEN)throw new Error("WPO_WCPDF_API_TOKEN ontbreekt");
 const auth=Buffer.from(c.key+":"+c.secret).toString("base64");
 const response=await axios({url:`${c.base}/wp-json/bendemen/v1/orders/${encodeURIComponent(wcOrderId)}/invoice`,method:"GET",headers:{Authorization:`Basic ${auth}`,"X-Bendemen-Invoice-Token":process.env.WPO_WCPDF_API_TOKEN},responseType:"arraybuffer",timeout:30000,validateStatus:status=>status>=200&&status<300});
 const pdf=Buffer.from(response.data);
 if(pdf.subarray(0,5).toString()!=="%PDF-")throw new Error("WP Overnight retourneerde geen geldige PDF");
 return pdf;
}
module.exports={request,listProducts,searchCustomers,getCustomer,createExpenseOrder,createWooOrder,updateWooOrder,createWooSubscription,refreshWooOrder,getInvoicePdf};
