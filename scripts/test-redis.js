require("dotenv").config({path:require("path").join(__dirname,"..",".env")});
const Redis=require("ioredis");

const options={
  connectTimeout:10000,
  maxRetriesPerRequest:1,
  retryStrategy:()=>null
};
let client;
if(process.env.REDIS_URL){
  client=new Redis(process.env.REDIS_URL,{...options,lazyConnect:true});
}else if(process.env.REDIS_HOST){
  client=new Redis({
    ...options,
    host:process.env.REDIS_HOST,
    port:Number(process.env.REDIS_PORT||6379),
    db:Number(process.env.REDIS_DB||0),
    username:process.env.REDIS_USERNAME||undefined,
    password:process.env.REDIS_PASSWORD||undefined,
    tls:process.env.REDIS_TLS==="true"?{}:undefined
  });
}else{
  throw new Error("Configureer REDIS_URL of REDIS_HOST.");
}

client.ping().then(async result=>{
  console.log("Redis verbinding OK:",result);
  await client.quit();
}).catch(error=>{
  console.error("Redis verbinding mislukt:",error.message);
  client.disconnect();
  process.exitCode=1;
});
