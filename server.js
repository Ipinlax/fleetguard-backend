// server.js - Complete FleetGuard AI Backend
// Deploy on Railway.app or Render for free/cheap

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

dotenv.config();
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ==================== DATABASE SETUP ====================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fleetguard', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected')).catch(err => console.log(err));

// ==================== DATABASE SCHEMAS ====================

// User Schema
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  company: String,
  userType: { type: String, enum: ['customer', 'reseller', 'admin'] },
  referralCode: String,
  referredBy: String,
  createdAt: { type: Date, default: Date.now },
});

// Vehicle Schema
const vehicleSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  plate: String,
  driver: String,
  expectedFuelCost: Number,
  actualFuelCost: Number,
  mileage: Number,
  lastMaintenance: Date,
  fuelEntries: [{
    date: Date,
    amount: Number,
    receipt: String,
  }],
  createdAt: { type: Date, default: Date.now },
});

// Reseller Schema
const resellerSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  referralCode: String,
  tier: { type: String, enum: ['silver', 'gold', 'platinum'], default: 'silver' },
  customersCount: { type: Number, default: 0 },
  monthlyRevenue: { type: Number, default: 0 },
  commissionRate: { type: Number, default: 40 },
  totalEarnings: { type: Number, default: 0 },
  bankAccount: String,
  createdAt: { type: Date, default: Date.now },
});

// Commission Schema
const commissionSchema = new mongoose.Schema({
  resellerId: mongoose.Schema.Types.ObjectId,
  customerId: mongoose.Schema.Types.ObjectId,
  amount: Number,
  status: { type: String, enum: ['pending', 'paid', 'pending_payout'], default: 'pending' },
  month: String,
  createdAt: { type: Date, default: Date.now },
});

// Subscription Schema
const subscriptionSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  resellerId: mongoose.Schema.Types.ObjectId,
  vehicleCount: Number,
  monthlyPrice: Number,
  status: { type: String, enum: ['active', 'trial', 'cancelled'], default: 'trial' },
  trialEndsAt: Date,
  nextBillingDate: Date,
  paymentMethodId: String,
  createdAt: { type: Date, default: Date.now },
});

// Models
const User = mongoose.model('User', userSchema);
const Vehicle = mongoose.model('Vehicle', vehicleSchema);
const Reseller = mongoose.model('Reseller', resellerSchema);
const Commission = mongoose.model('Commission', commissionSchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// ==================== EMAIL SETUP ====================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// ==================== HELPER FUNCTIONS ====================

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'secret123', { expiresIn: '30d' });
};

const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'secret123');
  } catch (error) {
    return null;
  }
};

const generateReferralCode = () => {
  return 'REF_' + Math.random().toString(36).substr(2, 9).toUpperCase();
};

// ==================== AUTH ROUTES ====================

// Register User
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, company, userType } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const referralCode = generateReferralCode();
    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      company,
      userType,
      referralCode,
    });

    await newUser.save();

    // If reseller, create reseller profile
    if (userType === 'reseller') {
      const reseller = new Reseller({
        userId: newUser._id,
        referralCode,
      });
      await reseller.save();
    }

    const token = generateToken(newUser._id);

    res.json({
      message: 'User registered successfully',
      token,
      user: {
        id: newUser._id,
        name,
        email,
        userType,
        referralCode,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
});

// Login User
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'User not found' });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(400).json({ message: 'Invalid password' });

    const token = generateToken(user._id);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        userType: user.userType,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
});

// ==================== CUSTOMER ROUTES ====================

// Add Vehicle
app.post('/api/vehicles', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ message: 'Unauthorized' });

    const { plate, driver, expectedFuelCost } = req.body;

    const vehicle = new Vehicle({
      userId: decoded.userId,
      plate,
      driver,
      expectedFuelCost,
      actualFuelCost: expectedFuelCost,
    });

    await vehicle.save();

    res.json({ message: 'Vehicle added', vehicle });
  } catch (error) {
    res.status(500).json({ message: 'Failed to add vehicle', error: error.message });
  }
});

// Get User Vehicles
app.get('/api/vehicles', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ message: 'Unauthorized' });

    const vehicles = await Vehicle.find({ userId: decoded.userId });

    res.json({ vehicles });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch vehicles', error: error.message });
  }
});

// Add Fuel Entry (Driver reports fuel receipt)
app.post('/api/fuel-entry', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ message: 'Unauthorized' });

    const { vehicleId, amount, receipt } = req.body;

    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });

    // Add fuel entry
    vehicle.fuelEntries.push({
      date: new Date(),
      amount,
      receipt,
    });

    // Update actual fuel cost (running average)
    vehicle.actualFuelCost = (vehicle.fuelEntries.reduce((sum, entry) => sum + entry.amount, 0) / vehicle.fuelEntries.length) * 1.2; // Monthly projection

    await vehicle.save();

    // AI Logic: Detect anomalies
    const anomaly = vehicle.actualFuelCost > vehicle.expectedFuelCost * 1.3;

    res.json({
      message: 'Fuel entry recorded',
      anomalyDetected: anomaly,
      anomalyLoss: anomaly ? Math.round(vehicle.actualFuelCost - vehicle.expectedFuelCost) : 0,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to record fuel entry', error: error.message });
  }
});

// Get Fleet Analytics
app.get('/api/analytics', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ message: 'Unauthorized' });

    const vehicles = await Vehicle.find({ userId: decoded.userId });

    const totalLosses = vehicles.reduce((sum, v) => {
      return sum + Math.max(0, v.actualFuelCost - v.expectedFuelCost);
    }, 0);

    const anomalies = vehicles.filter(v => v.actualFuelCost > v.expectedFuelCost * 1.2).length;

    res.json({
      totalVehicles: vehicles.length,
      totalFuelLosses: totalLosses,
      anomaliesDetected: anomalies,
      averageLossPerVehicle: Math.round(totalLosses / vehicles.length),
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch analytics', error: error.message });
  }
});

// ==================== RESELLER ROUTES ====================

// Get Reseller Dashboard
app.get('/api/reseller/dashboard', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ message: 'Unauthorized' });

    const reseller = await Reseller.findOne({ userId: decoded.userId });
    if (!reseller) return res.status(404).json({ message: 'Reseller not found' });

    const commissions = await Commission.find({ resellerId: reseller._id });
    const totalCommissions = commissions.reduce((sum, c) => sum + c.amount, 0);

    res.json({
      reseller: {
        tier: reseller.tier,
        customersCount: reseller.customersCount,
        referralCode: reseller.referralCode,
        monthlyRevenue: reseller.monthlyRevenue,
        commissionRate: reseller.commissionRate,
        totalEarnings: reseller.totalEarnings,
      },
      recentCommissions: commissions.slice(-5),
      totalCommissions,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch dashboard', error: error.message });
  }
});

// Get Reseller's Customers
app.get('/api/reseller/customers', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ message: 'Unauthorized' });

    const subscriptions = await Subscription.find({ resellerId: decoded.userId }).populate('userId', 'name email company');

    res.json({ customers: subscriptions });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch customers', error: error.message });
  }
});

// ==================== SUBSCRIPTION / PAYMENT ROUTES ====================

// Create Subscription (Customer starts trial)
app.post('/api/subscription/create', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ message: 'Unauthorized' });

    const { vehicleCount, referralCode } = req.body;

    let resellerId = null;
    if (referralCode) {
      const reseller = await Reseller.findOne({ referralCode });
      if (reseller) resellerId = reseller._id;
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30); // 30-day trial

    const subscription = new Subscription({
      userId: decoded.userId,
      resellerId,
      vehicleCount,
      monthlyPrice: vehicleCount * 5000, // ₦5,000 per vehicle
      status: 'trial',
      trialEndsAt,
    });

    await subscription.save();

    // Update reseller's customer count
    if (resellerId) {
      await Reseller.findByIdAndUpdate(resellerId, {
        $inc: { customersCount: 1, monthlyRevenue: subscription.monthlyPrice },
      });
    }

    res.json({
      message: 'Subscription created',
      subscription,
      trialEndsAt,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create subscription', error: error.message });
  }
});

// Upgrade to Paid (Paystack Integration)
app.post('/api/payment/paystack', async (req, res) => {
  try {
    const { email, amount, subscriptionId } = req.body;

    // Initialize Paystack transaction
    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email,
      amount: amount * 100, // Convert to kobo
    }, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });

    res.json({
      authorizationUrl: response.data.data.authorization_url,
      accessCode: response.data.data.access_code,
      reference: response.data.data.reference,
    });
  } catch (error) {
    res.status(500).json({ message: 'Payment failed', error: error.message });
  }
});

// Verify Payment
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { reference, subscriptionId } = req.body;

    // Verify with Paystack
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });

    if (response.data.data.status === 'success') {
      // Update subscription to active
      const subscription = await Subscription.findByIdAndUpdate(subscriptionId, {
        status: 'active',
        paymentMethodId: reference,
        nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, { new: true });

      res.json({
        message: 'Payment successful',
        subscription,
      });
    } else {
      res.status(400).json({ message: 'Payment verification failed' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Verification failed', error: error.message });
  }
});

// ==================== COMMISSION ROUTES ====================

// Calculate Monthly Commissions (Run this monthly)
app.post('/api/admin/calculate-commissions', async (req, res) => {
  try {
    const resellers = await Reseller.find();

    for (const reseller of resellers) {
      const subscriptions = await Subscription.find({ resellerId: reseller._id, status: 'active' });
      const totalRevenue = subscriptions.reduce((sum, sub) => sum + sub.monthlyPrice, 0);
      const commission = Math.round(totalRevenue * (reseller.commissionRate / 100));

      const newCommission = new Commission({
        resellerId: reseller._id,
        amount: commission,
        status: 'pending_payout',
        month: new Date().toISOString().slice(0, 7),
      });

      await newCommission.save();

      // Update reseller earnings
      await Reseller.findByIdAndUpdate(reseller._id, {
        $inc: { totalEarnings: commission },
      });
    }

    res.json({ message: 'Commissions calculated' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to calculate commissions', error: error.message });
  }
});

// Process Payouts (Manual trigger)
app.post('/api/admin/process-payouts', async (req, res) => {
  try {
    const commissions = await Commission.find({ status: 'pending_payout' });

    for (const commission of commissions) {
      const reseller = await Reseller.findById(commission.resellerId);

      // Send payout (integrate with payment gateway)
      // For now, just mark as paid
      commission.status = 'paid';
      await commission.save();

      // Send email notification
      const user = await User.findById(reseller.userId);
      await transporter.sendMail({
        to: user.email,
        subject: 'FleetGuard Commission Payout',
        html: `<h2>Your commission of ₦${commission.amount} has been paid!</h2>
               <p>Check your bank account.</p>`,
      });
    }

    res.json({ message: 'Payouts processed' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to process payouts', error: error.message });
  }
});

// ==================== EMAIL ROUTES ====================

// Send Reseller Kit Email
app.post('/api/email/send-reseller-kit', async (req, res) => {
  try {
    const { email, name, referralCode } = req.body;

    await transporter.sendMail({
      to: email,
      subject: 'Welcome to FleetGuard AI Reseller Program!',
      html: `
        <h2>Welcome ${name}!</h2>
        <p>You're now a FleetGuard AI reseller.</p>
        <h3>Your Referral Code: <strong>${referralCode}</strong></h3>
        <p>Use this code to track your customers and commissions.</p>
        <h3>Your Reseller Kit Includes:</h3>
        <ul>
          <li>Sales Scripts & Email Templates</li>
          <li>Demo Dashboard Access</li>
          <li>Marketing Materials</li>
          <li>Commission Tracking Dashboard</li>
        </ul>
        <p>Start earning ₦40k-200k monthly!</p>
        <a href="https://your-domain.com/reseller-dashboard">Access Your Dashboard</a>
      `,
    });

    res.json({ message: 'Email sent' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to send email', error: error.message });
  }
});

// ==================== WEBHOOK ROUTES ====================

// Paystack Webhook (Automatic payment verification)
app.post('/api/webhooks/paystack', async (req, res) => {
  try {
    const { data } = req.body;

    if (data.status === 'success') {
      // Update subscription
      // Extract subscription ID from metadata if included
      const subscription = await Subscription.findOneAndUpdate(
        { 'paymentMethodId': data.reference },
        {
          status: 'active',
          nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        { new: true }
      );

      console.log('Subscription activated:', subscription);
    }

    res.json({ message: 'Webhook received' });
  } catch (error) {
    res.status(500).json({ message: 'Webhook error', error: error.message });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend is running', timestamp: new Date() });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`FleetGuard Backend running on port ${PORT}`);
});
