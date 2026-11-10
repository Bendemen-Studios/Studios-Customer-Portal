const db = require("./db");
function requireAuth(req,res,next){
  if(!req.session.user)return res.redirect("/login");
  const user=db.prepare("SELECT id,name,email,role,active FROM users WHERE id=?").get(req.session.user.id);
  if(!user||user.active!==1){req.session.destroy(()=>{});return res.redirect("/login?disabled=1");}
  req.session.user={id:user.id,name:user.name,email:user.email,role:user.role};
  next();
}
function requireAdmin(req,res,next){if(req.session.user?.role!=="admin")return res.status(403).send("Geen toegang.");next();}
module.exports={requireAuth,requireAdmin};
