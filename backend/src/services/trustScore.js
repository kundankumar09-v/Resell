/**
 * Trust Score Service
 *
 * Calculates a transparent 0-100 score for sellers.
 *
 * Components:
 *  - Account age (0-15)
 *  - Sales / activity (0-20)
 *  - Average rating (0-25)
 *  - Response time (0-15)
 *  - Complaint-free ratio (0-15)
 *  - Listing quality (0-10)
 *
 * Trust-gaming defense: the sales component is capped at 50% of its maximum
 * (10 of 20 points) when a seller's recent sales are concentrated in a small
 * set of repeat buyers (the same buyers inflating each other's reputations /
 * self-dealing). Concentration is measured over the last 20 sales; > 60%
 * repeat buyers triggers the cap. The cap is transparent — the ratio and the
 * cap flag are exposed in the breakdown.
 */

const User = require('../models/User');
const Product = require('../models/Product');
const Review = require('../models/Review');
const Sale = require('../models/Sale');
const Report = require('../models/Report');

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

const calculateTrustScore = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    return { score: 0, breakdown: {}, level: 'unknown' };
  }

  // 1. Account age (0-15)
  const ageInDays = Math.floor((Date.now() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24));
  const ageScore = clamp((ageInDays / 365) * 15, 0, 15);

  // 2. Sales (0-20) with a trust-gaming concentration cap
  const salesCount = await Sale.countDocuments({ seller: userId });
  let salesScore = clamp(Math.log10(salesCount + 1) * 10, 0, 20);

  // Repeat-buyer concentration over the 20 most recent sales. A seller whose
  // recent sales all come from a handful of repeat buyers may be farming
  // reputation with confederates; cap the sales component at half its max so
  // the practice can no longer inflate the final score materially.
  const recentSales = await Sale.find({ seller: userId })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('buyer');
  let concentrationRatio = 0;
  let salesConcentrationCapped = false;
  if (recentSales.length > 0) {
    const uniqueBuyers = new Set(recentSales.map((s) => String(s.buyer))).size;
    concentrationRatio = 1 - uniqueBuyers / recentSales.length;
    if (concentrationRatio > 0.6) {
      salesScore = clamp(Math.min(salesScore, 10), 0, 20);
      salesConcentrationCapped = true;
    }
  }

  // 3. Rating (0-25)
  const reviews = await Review.find({ seller: userId });
  const avgRating =
    reviews.length > 0
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : 3.5;
  const ratingScore = clamp((avgRating / 5) * 25, 0, 25);

  // 4. Response time (0-15)
  const avgResponse = user.averageResponseMinutes || 60;
  const responseScore = clamp(15 - (avgResponse / 60) * 5, 0, 15);

  // 5. Complaints-free ratio (0-15)
  const totalReports = await Report.countDocuments({
    target: userId,
    targetType: 'user',
  });
  const complaintRatio = Math.max(0, 1 - (user.complaints + totalReports) / 20);
  const complaintScore = clamp(complaintRatio * 15, 0, 15);

  // 6. Listing quality (0-10)
  const userProducts = await Product.find({ seller: userId });
  let qualityScore = 0;
  if (userProducts.length > 0) {
    const avgImages =
      userProducts.reduce((s, p) => s + (p.images?.length || 0), 0) /
      userProducts.length;
    const described = userProducts.filter(
      (p) => p.description && p.description.length > 100
    ).length;
    const descriptionRatio = described / userProducts.length;
    qualityScore = clamp((Math.min(avgImages, 5) / 5) * 5 + descriptionRatio * 5, 0, 10);
  }

  const total = Math.round(
    ageScore + salesScore + ratingScore + responseScore + complaintScore + qualityScore
  );

  let level = 'new';
  if (total >= 80) level = 'excellent';
  else if (total >= 65) level = 'trusted';
  else if (total >= 45) level = 'established';
  else if (total >= 25) level = 'developing';

  return {
    score: clamp(total, 0, 100),
    level,
    breakdown: {
      accountAge: { score: Math.round(ageScore), max: 15, days: ageInDays },
      sales: {
        score: Math.round(salesScore),
        max: 20,
        count: salesCount,
        concentrationRatio: Number(concentrationRatio.toFixed(2)),
        capped: salesConcentrationCapped,
      },
      rating: {
        score: Math.round(ratingScore),
        max: 25,
        average: Number(avgRating.toFixed(2)),
        count: reviews.length,
      },
      responseTime: {
        score: Math.round(responseScore),
        max: 15,
        avgMinutes: avgResponse,
      },
      complaints: {
        score: Math.round(complaintScore),
        max: 15,
        complaints: user.complaints + totalReports,
      },
      listingQuality: {
        score: Math.round(qualityScore),
        max: 10,
        listings: userProducts.length,
      },
    },
  };
};

module.exports = { calculateTrustScore };
