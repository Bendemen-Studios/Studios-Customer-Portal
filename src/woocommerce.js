const axios=require("axios");
function config(){const base=(process.env.WC_STORE_URL||"").replace(/\/$/,"");if(!base||!process.env.WC_CONSUMER_KEY||!process.env.WC_CONSUMER_SECRET)throw new Error("WooCommerce API configuration is incomplete");return{base,key:process.env.WC_CONSUMER_KEY,secret:process.env.WC_CONSUMER_SECRET};}
async function request(endpoint,method="GET",data){const c=config();const auth=Buffer.from(c.key+":"+c.secret).toString("base64");const r=await axios({url:`${c.base}/wp-json/wc/v3/${endpoint}`,method,data,headers:{Authorization:`Basic ${auth}`},timeout:20000});return r.data;}
async function listProducts(page=1,perPage=100){return request(`products?status=publish&per_page=${Math.min(100,perPage)}&page=${page}`);}
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
async function createWooOrder(localOrderId){throw new Error("WooCommerce order creation requires the configured local-order mapping service.");}
async function refreshWooOrder(localOrderId){return null;}
async function getInvoice(wcOrderId){return request(`orders/${encodeURIComponent(wcOrderId)}?context=view`);}
module.exports={request,listProducts,createExpenseOrder,createWooOrder,refreshWooOrder,getInvoice};
