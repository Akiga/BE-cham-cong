
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import coreRoutes from './routes/core.js';

const app=express();
app.set('trust proxy', 1);
const allowedOrigins = [
  'https://ssm-cham-cong.vercel.app/',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json({limit:'1mb'}));
app.use('/api/auth',rateLimit({windowMs:15*60*1000,max:30}),authRoutes);
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'attendance-api'}));
app.use('/api',coreRoutes);
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({message:'Lỗi máy chủ'});});
const port=Number(process.env.PORT)||5000;
app.listen(port,()=>console.log(`API running at http://localhost:${port}`));
