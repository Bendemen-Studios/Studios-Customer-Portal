const axios=require("axios");
function config(){const base=(process.env.WC_STORE_URL||"").replace(/\/$/,"");if(!base||!process.env.WC_CONSUMER_KEY||!process.env.WC_CONSUMER_SECRET)throw new Error("WooCommerce API configuration is incomplete");return{base,key:process.env.WC_CONSUMER_KEY,secret:process.env.WC_CONSUMER_SECRET};}
async function request(endpoint,method="GET",data){const c=config();const auth=Buffer.from(c.key+":"+c.secret).toString("base64");const r=await axios({url:`${c.base}/wp-json/wc/v3/${endpoint}`,method,data,headers:{Authorization:`Basic ${auth}`},timeout:20000});return r.data;}
async function createWooOrder(localOrderId){throw new Error("WooCommerce order creation requires the configured local-order mapping service.");}
async function refreshWooOrder(localOrderId){return null;}
async function getInvoice(wcOrderId){return request(`orders/${encodeURIComponent(wcOrderId)}?context=view`);}
module.exports={request,createWooOrder,refreshWooOrder,getInvoice};
