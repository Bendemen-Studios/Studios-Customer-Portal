require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const Database=require("better-sqlite3"), mysql=require("mysql2/promise"), path=require("path");
for(const k of ["DB_HOST","DB_NAME","DB_USER","DB_PASSWORD"])if(!process.env[k])throw new Error(k+" ontbreekt in Pterodactyl environment.");
const sqlite=new Database(path.resolve(process.env.DB_PATH||"./data/bendemen.sqlite"),{readonly:true,fileMustExist:true});
const q=s=>"\`"+String(s).replace(/\`/g,"\`\`")+"\`";
function type(c){if(c.pk)return "BIGINT NOT NULL AUTO_INCREMENT";const t=String(c.type||"").toUpperCase();if(t.includes("INT"))return "BIGINT";if(/REAL|FLOA|DOUB/.test(t))return "DOUBLE";if(t.includes("BLOB"))return "LONGBLOB";if(t.includes("BOOL"))return "TINYINT(1)";return "LONGTEXT";}
async function main(){
 const pool=mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,charset:"utf8mb4",connectionLimit:2,connectTimeout:10000});
 const c=await pool.getConnection();try{
 await c.query("SELECT 1");await c.query("SET FOREIGN_KEY_CHECKS=0");
 const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY CASE name WHEN 'users' THEN 1 WHEN 'orders' THEN 2 ELSE 3 END").all().map(x=>x.name);const report=[];
 for(const table of tables){
  const cols=sqlite.prepare("PRAGMA table_info("+q(table)+")").all();if(!cols.length)continue;
  const defs=cols.map(x=>q(x.name)+" "+type(x)+(x.notnull&&!x.pk?" NOT NULL":"")+(x.dflt_value!==null&&x.dflt_value!==undefined&&!x.pk?" DEFAULT "+x.dflt_value:""));
  await c.query("CREATE TABLE IF NOT EXISTS "+q(table)+" ("+defs.join(",")+") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  const rows=sqlite.prepare("SELECT * FROM "+q(table)).all(),[count]=await c.query("SELECT COUNT(*) n FROM "+q(table));
  if(Number(count[0].n)>0){report.push({table,source:rows.length,target:Number(count[0].n),status:"bestaat al; niet overschreven"});continue;}
  if(rows.length){const sql="INSERT INTO "+q(table)+" ("+cols.map(x=>q(x.name)).join(",")+") VALUES ("+cols.map(()=>"?").join(",")+")";for(let i=0;i<rows.length;i+=100)for(const row of rows.slice(i,i+100))await c.query(sql,cols.map(x=>row[x.name]));}
  for(const idx of sqlite.prepare("PRAGMA index_list("+q(table)+")").all()){
   if(idx.origin==="pk"||idx.partial)continue;const ic=sqlite.prepare("PRAGMA index_info("+q(idx.name)+")").all().map(x=>q(x.name));if(!ic.length)continue;
   try{await c.query("CREATE "+(idx.unique?"UNIQUE ":"")+"INDEX "+q("mig_"+table+"_"+idx.name)+" ON "+q(table)+" ("+ic.join(",")+")");}catch(e){if(!["ER_DUP_KEYNAME","ER_DUP_ENTRY"].includes(e.code))throw e;}
  }
  const [v]=await c.query("SELECT COUNT(*) n FROM "+q(table));if(Number(v[0].n)!==rows.length)throw new Error("Rijcontrole mislukt: "+table);
  report.push({table,source:rows.length,target:Number(v[0].n),status:"OK"});
 }
 await c.query("SET FOREIGN_KEY_CHECKS=1");console.log(JSON.stringify({message:"Kopie gemaakt; SQLite blijft actief. Controleer rapport vóór omschakeling.",tables:report},null,2));
 }finally{c.release();await pool.end();sqlite.close();}
}
main().catch(e=>{console.error("Migratie gestopt:",e.message);process.exitCode=1;});