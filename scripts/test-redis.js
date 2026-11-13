require("dotenv").config({path:require("path").join(__dirname,"..",".env")});
const Redis=require("ioredis");
if(!process.env.REDIS_HOST||!process.env.REDIS_PASSWORD)throw new Error("REDIS_HOST en REDIS_PASSWORD ontbreken.");
const r=new Redis({host:process.env.REDIS_HOST,port:Number(process.env.REDIS_PORT||6379),username:process.env.REDIS_USERNAME||"default",password:process.env.REDIS_PASSWORD,tls:process.env.REDIS_TLS==="true"?{}:undefined,connectTimeout:10000,maxRetriesPerRequest:1,retryStrategy:()=>null});
r.ping().then(async x=>{console.log("Redis verbinding OK:",x);await r.quit();}).catch(e=>{console.error("Redis verbinding mislukt:",e.message);r.disconnect();process.exitCode=1;});