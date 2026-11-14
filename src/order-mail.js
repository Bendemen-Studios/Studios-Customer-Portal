const nodemailer=require("nodemailer");
const PDFDocument=require("pdfkit");
function configured(){return Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS&&process.env.SMTP_FROM&&process.env.PANEL_PUBLIC_URL);}
function transporter(){if(!configured())throw new Error("SMTP configuratie ontbreekt");return nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||465),secure:String(process.env.SMTP_SECURE||"true")==="true",auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});}
function makePdf(order){return new Promise((resolve,reject)=>{const doc=new PDFDocument({margin:48}),chunks=[];doc.on("data",c=>chunks.push(c));doc.on("end",()=>resolve(Buffer.concat(chunks)));doc.on("error",reject);doc.fontSize(20).text("Bendemen Studios");doc.moveDown().fontSize(14).text("Pro-forma betalingsverzoek");doc.moveDown().fontSize(10).text(`Bestelling #${order.number||order.id}`);for(const item of order.line_items||[])doc.text(`${item.name} × ${item.quantity}`);doc.moveDown().fontSize(12).text(`Totaal: ${order.total||""} ${order.currency||""}`);doc.moveDown().fontSize(9).text("Dit document is een pro-forma betalingsverzoek en geen definitieve btw-factuur.");doc.end();});}
async function sendAutomatedOrderEmail({to,order}){if(!configured()){console.warn("Bestelmail niet verzonden: SMTP configuratie ontbreekt.");return false;}const url=`${process.env.PANEL_PUBLIC_URL.replace(/\/$/,"")}/orders/${encodeURIComponent(order.id)}`;const pdf=await makePdf(order);await transporter().sendMail({from:process.env.SMTP_FROM,to,subject:`Bendemen Studios – bestelling #${order.number||order.id}`,text:`Bekijk je bestelling en betaal veilig in het Bendemen Supply Panel: ${url}`,html:`<p>Je bestelling staat klaar.</p><p><a href="${url}">Bekijk bestelling en betaal veilig</a></p>`,attachments:[{filename:`bestelling-${order.number||order.id}.pdf`,content:pdf}]});return true;}
async function sendScheduledOrderReminder({to,order,daysBefore,orderDate}) {
 if(!configured()){console.warn("Bestelherinnering niet verzonden: SMTP configuratie ontbreekt.");return false;}
 const url=`${process.env.PANEL_PUBLIC_URL.replace(/\\/$/,"")}/orders/${encodeURIComponent(order.id)}`;
 const date=new Intl.DateTimeFormat("nl-NL",{dateStyle:"long",timeZone:"Europe/Amsterdam"}).format(new Date(orderDate+"T12:00:00+01:00"));
 const subject=daysBefore===7
  ? `Herinnering: je bestelling staat over 7 dagen gepland`
  : `Laatste herinnering: je bestelling staat over 3 dagen gepland`;
 const text=`Je geplande bestelling staat gepland op ${date}. Bekijk de bestelling in het Bendemen Supply Panel: ${url}`;
 await transporter().sendMail({
  from:process.env.SMTP_FROM,to,subject,text,
  html:`<p>Dit is een herinnering voor je geplande bestelling.</p><p>De bestelling staat gepland op <strong>${date}</strong> (over ${daysBefore} dagen).</p><p><a href="${url}">Bekijk je bestelling in het Bendemen Supply Panel</a></p><p>Heb je vragen? Neem dan contact met ons op.</p>`
 });
 return true;
}
module.exports={sendAutomatedOrderEmail,sendScheduledOrderReminder,configured};
