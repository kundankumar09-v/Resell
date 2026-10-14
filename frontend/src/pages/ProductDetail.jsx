import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Heart,
  Share2,
  Flag,
  MessageCircle,
  MapPin,
  Calendar,
  Eye,
  ChevronLeft,
  ShieldCheck,
  ChevronRight,
  Send,
  Tag,
  Sparkles,
  Star,
  Info,
  Check,
  AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { productService, favoriteService, chatService, reportService, sellerService, offerService } from '../services/services';
import { productVerificationService } from '../services/productVerification';
import { useAuth } from '../contexts/AuthContext';
import { formatDate, getConditionLabel, getConditionColor, cn } from '../utils/format';
import ImageGallery from '../components/product/ImageGallery';
import AIAnalysisPanel from '../components/product/AIAnalysisPanel';
import SellerInfo from '../components/product/SellerInfo';
import ProductCard from '../components/product/ProductCard';
import DeliveryAddressForm from '../components/checkout/DeliveryAddressForm';
import Price from '../components/ui/Price';
import useFormatPrice from '../hooks/useFormatPrice';
import PageTransition from '../components/layout/PageTransition';
import Loader from '../components/ui/Loader';
import ErrorState from '../components/ui/ErrorState';
import { ScrollReveal, RevealOnScroll } from '../components/ui/ScrollReveal';
import MagneticButton from '../components/ui/MagneticButton';

export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [product, setProduct] = useState(null);
  const [trust, setTrust] = useState(null);
  const [similar, setSimilar] = useState([]);
  const [favorited, setFavorited] = useState(false);
  const [reviewData, setReviewData] = useState({ reviews: [], summary: { count: 0, average: 0 }, canReview: { allowed: false, reason: 'login_required' } });
  const [loading, setLoading] = useState(true);
  const [showReport, setShowReport] = useState(false);
  const [showAddressModal, setShowAddressModal] = useState(false);
  const [showOfferModal, setShowOfferModal] = useState(false);
  const [identity, setIdentity] = useState(null);
  const [possessCode, setPossessCode] = useState('');
  const [possessProof, setPossessProof] = useState(null);
  const [possessBusy, setPossessBusy] = useState(false);
  const [challengeBusy, setChallengeBusy] = useState(false);

  useEffect(() => {
    setLoading(true);
    productService
      .get(id)
      .then((r) => setProduct(r.data.product))
      .catch(() => setProduct(null))
      .finally(() => setLoading(false));

    productService.similar(id).then((r) => setSimilar(r.data.items)).catch(() => {});
  }, [id]);

  const loadReviews = useCallback((productId) => {
    productService
      .reviews(productId)
      .then((r) =>
        setReviewData({
          reviews: r.data.reviews || [],
          summary: r.data.summary || { count: 0, average: 0 },
          canReview: r.data.canReview || { allowed: false, reason: 'login_required' },
        })
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!product) return;
    if (product.seller?._id) {
      sellerService.trust(product.seller._id).then((r) => setTrust(r.data.trust)).catch(() => {});
    }
    if (user) {
      favoriteService.check(id).then((r) => setFavorited(r.data.favorited)).catch(() => {});
    }
    // Identity/provenance status: the owner gets possession details, buyers
    // and anonymous viewers get the buyer-facing trust signals (the API
    // never exposes the raw identifier or internal fraud scores).
    productService.identityStatus(id).then((r) => setIdentity(r.data)).catch(() => {});
    loadReviews(product._id);
  }, [product, user, id, loadReviews]);

  const refreshIdentity = async () => {
    try {
      const r = await productService.identityStatus(id);
      setIdentity(r.data);
    } catch {
      /* ignore */
    }
  };

  const handleRequestChallenge = async () => {
    try {
      setChallengeBusy(true);
      await productVerificationService.request(id);
      toast.success('New verification code issued — show it beside the product in your proof photo.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not request a verification code');
    } finally {
      await refreshIdentity();
      setChallengeBusy(false);
    }
  };

  const handleVerifyPossession = async () => {
    if (!possessProof || !possessCode.trim()) {
      toast.error('Add a proof photo and enter the verification code shown in it');
      return;
    }
    try {
      setPossessBusy(true);
      const fd = new FormData();
      fd.append('images', possessProof);
      const up = await productService.uploadImages(fd);
      const proofImageUrl = up.data?.images?.[0]?.url;
      if (!proofImageUrl) throw new Error('Proof photo upload failed');
      const { data } = await productService.verifyPossession(id, {
        code: possessCode.trim().toUpperCase(),
        proofImageUrl,
      });
      if (data.possessionStatus === 'verified') {
        toast.success('Possession verified!');
        setPossessCode('');
        setPossessProof(null);
      } else {
        toast.error(
          `Verification failed — ${data.remainingAttempts ?? 0} attempts remaining.`
        );
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Verification failed');
    } finally {
      await refreshIdentity();
      setPossessBusy(false);
    }
  };

  const handleFavorite = async () => {
    if (!user) {
      toast.error('Please log in to save items');
      return;
    }
    try {
      if (favorited) {
        await favoriteService.remove(id);
        setFavorited(false);
        toast.success('Removed from favorites');
      } else {
        await favoriteService.add(id);
        setFavorited(true);
        toast.success('Added to favorites');
      }
    } catch {
      toast.error('Failed to update favorite');
    }
  };

  const handleContactSeller = async () => {
    if (!user) {
      toast.error('Please log in to message the seller');
      return;
    }
    if (product.seller._id === user._id) {
      toast.error('You cannot message yourself');
      return;
    }
    setShowAddressModal(true);
  };

  const handleAddressConfirmed = async (address) => {
    setShowAddressModal(false);
    try {
      const { data } = await chatService.createConversation({
        recipientId: product.seller._id,
        productId: product._id,
      });
      try {
        const addrText = [
          `Hi! I'm interested in "${product.title}".`,
          '',
          'Delivery address:',
          address.fullName,
          address.phone,
          address.line1,
          address.line2,
          [address.city, address.state, address.postalCode].filter(Boolean).join(', '),
          address.country,
        ].filter(Boolean).join('\n');
        await chatService.send({ conversationId: data.conversation._id, content: addrText });
      } catch {
        /* conversation was created; first message can be sent from chat page */
      }
      navigate(`/chat/${data.conversation._id}`);
    } catch {
      toast.error('Failed to start conversation');
    }
  };

  const handleReport = async (data) => {
    try {
      await reportService.create({
        targetType: 'product',
        target: id,
        ...data,
      });
      toast.success('Report submitted. Thank you.');
      setShowReport(false);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to submit report');
    }
  };

  const handleOffer = async ({ amount, message }) => {
    if (!user) {
      toast.error('Please log in to make an offer');
      return;
    }
    if (product.seller._id === user._id) {
      toast.error('You cannot make an offer on your own listing');
      return;
    }
    if (!amount || Number(amount) <= 0) {
      toast.error('Enter a valid offer amount');
      return;
    }
    if (Number(amount) >= product.price) {
      toast.error('Offer must be below the listed price');
      return;
    }
    try {
      await offerService.create({
        productId: product._id,
        amount: Number(amount),
        message,
      });
      toast.success('Offer sent to seller');
      setShowOfferModal(false);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to send offer');
    }
  };

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: product.title, url });
      } catch {
        /* user cancelled */
      }
    } else {
      try {
        await navigator.clipboard.writeText(url);
        toast.success('Link copied to clipboard');
      } catch {
        toast.error('Could not copy link');
      }
    }
  };

  if (loading) return <Loader />;
  if (!product) return <ErrorState title="Product not found" />;

  return (
    <PageTransition>
      <div className="relative">

        <div className="container-page py-8 pb-28 lg:pb-8 relative z-10">
          {/* Back button */}
          <ScrollReveal direction="left">
            <button
              onClick={() => navigate(-1)}
              className="flex items-center gap-2 text-slate-500 hover:text-slate-900 mb-6 group"
            >
              <motion.div
                whileHover={{ x: -4 }}
                className="w-8 h-8 rounded-xl bg-white border border-slate-200 grid place-items-center shadow-sm group-hover:shadow-md transition-all"
              >
                <ChevronLeft className="w-4 h-4" />
              </motion.div>
              <span className="font-medium">Back</span>
            </button>
          </ScrollReveal>

          {/* AI Moderation & Flagged Notice */}
          {(product.status === 'pendingReview' || product.isFlagged) && (
            <div className="mb-6 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-amber-800 dark:text-amber-200">
              <div className="flex items-start sm:items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5 sm:mt-0" />
                <div>
                  <p className="font-semibold text-sm">
                    {product.status === 'pendingReview' ? 'Listing Under AI Moderation Review' : 'Listing Flagged for Review'}
                  </p>
                  <p className="text-xs opacity-85">
                    {product.fraudReasons && product.fraudReasons.length > 0
                      ? `Signals detected: ${product.fraudReasons.join(' · ')}`
                      : 'This listing is held for security verification and is temporarily hidden from public discovery.'}
                  </p>
                </div>
              </div>
              <span className="badge bg-amber-500/20 text-amber-700 dark:text-amber-300 font-mono text-xs self-start sm:self-center">
                Risk Score: {product.fraudScore !== undefined && product.fraudScore !== null ? `${product.fraudScore}/100` : 'Pending'}
              </span>
            </div>
          )}

          <div className="grid lg:grid-cols-3 gap-8">
            {/* Left: Gallery + Details */}
            <div className="lg:col-span-2 space-y-6">
              <ScrollReveal direction="up">
                <ImageGallery images={product.images} />
              </ScrollReveal>

              <ScrollReveal delay={0.1} direction="up">
                <div className="card p-6">
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className={cn('badge border', getConditionColor(product.condition))}>
                          {getConditionLabel(product.condition)}
                        </span>
                        {product.brand && (
                          <span className="badge bg-slate-100 text-slate-700">{product.brand}</span>
                        )}
                        {product.category && (
                          <span className="badge bg-brand-50 text-brand-700">{product.category.name}</span>
                        )}
                      </div>
                      <h1 className="font-display font-bold text-2xl md:text-3xl mb-2">{product.title}</h1>
                      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500">
                        <span className="flex items-center gap-1">
                          <Eye className="w-4 h-4" /> {product.views} views
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="w-4 h-4" /> {formatDate(product.createdAt)}
                        </span>
                        {product.location?.city && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-4 h-4" /> {product.location.city}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mb-6">
                    <Price
                      amount={product.price}
                      originalPrice={product.originalPrice}
                      fromCurrency={product.currencyCode || 'USD'}
                      size="lg"
                    />
                    {product.originalPrice > product.price && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="badge bg-emerald-100 text-emerald-700">
                          Save {Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)}%
                        </span>
                      </div>
                    )}
                  </div>

                  <motion.p
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-slate-700 leading-relaxed whitespace-pre-line mb-6"
                  >
                    {product.description}
                  </motion.p>

                  {product.specifications?.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="border-t border-slate-200 pt-6"
                    >
                      <h3 className="font-semibold mb-3">Specifications</h3>
                      <div className="grid sm:grid-cols-2 gap-2">
                        {product.specifications.map((s, i) => (
                          <motion.div
                            key={i}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.03 }}
                            className="flex justify-between p-3 rounded-lg bg-slate-50 text-sm"
                          >
                            <span className="text-slate-500">{s.key}</span>
                            <span className="font-medium">{s.value}</span>
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Product Verification (SCRUM-25): possession challenge
                      (listing owner only, tracked identities). Status is
                      determined by the backend — Pending / Verified / Failed
                      / Expired. Raw identifiers are never exposed. */}
                  {user && product.seller?._id === user._id && identity?.tracked && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="border-t border-slate-200 pt-6"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <h3 className="font-semibold">Product Verification</h3>
                        {(() => {
                          const possessionStatus = identity.verification?.possessionStatus || 'unverified';
                          const expired =
                            possessionStatus !== 'verified' &&
                            identity.possession?.codeExpiresAt &&
                            new Date(identity.possession.codeExpiresAt) < new Date();
                          const label = possessionStatus === 'verified' ? 'Verified' : possessionStatus === 'failed' ? 'Failed' : expired ? 'Expired' : 'Pending';
                          const tone =
                            possessionStatus === 'verified'
                              ? 'bg-emerald-100 text-emerald-700'
                              : possessionStatus === 'failed' || expired
                              ? 'bg-red-100 text-red-700'
                              : 'bg-amber-100 text-amber-700';
                          return (
                            <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', tone)}>
                              {label}
                            </span>
                          );
                        })()}
                      </div>
                      {identity.verification?.possessionStatus === 'verified' ? (
                        <p className="text-sm text-emerald-600">
                          Possession verified — buyers can see this listing has verified physical ownership.
                        </p>
                      ) : (
                        <>
                          <p className="text-sm text-slate-500 mb-3">
                            Upload a photo of the physical product showing code{' '}
                            <span className="font-mono font-semibold text-slate-700">
                              {identity.possession?.verificationCode || '—'}
                            </span>{' '}
                            (and its serial/IMEI where possible), then enter the code below.{' '}
                            {identity.possession?.codeExpiresAt &&
                              `Valid until ${new Date(identity.possession.codeExpiresAt).toLocaleString()}.`}
                            {identity.warnings?.length > 0 && (
                              <span className="block mt-1 text-amber-600">{identity.warnings[0]}</span>
                            )}
                          </p>
                          <div className="flex flex-col sm:flex-row gap-3">
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) => setPossessProof(e.target.files?.[0] || null)}
                              className="text-sm file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-slate-100 file:text-sm"
                            />
                            <input
                              type="text"
                              value={possessCode}
                              onChange={(e) => setPossessCode(e.target.value)}
                              placeholder="Enter code from photo"
                              className="input flex-1"
                            />
                            <button
                              type="button"
                              onClick={handleVerifyPossession}
                              disabled={possessBusy}
                              className="btn-primary whitespace-nowrap disabled:opacity-50"
                            >
                              {possessBusy ? 'Verifying…' : 'Verify'}
                            </button>
                          </div>
                          {/* Request a fresh short-lived code (backend-issued;
                              never trusted from the client). Useful when the
                              current code has expired or was never issued. */}
                          {(() => {
                            const expired =
                              identity.possession?.codeExpiresAt &&
                              new Date(identity.possession.codeExpiresAt) < new Date();
                            const hasCode = !!identity.possession?.verificationCode;
                            return (
                              <button
                                type="button"
                                onClick={handleRequestChallenge}
                                disabled={challengeBusy}
                                className="mt-3 text-xs text-slate-500 underline hover:text-slate-700 disabled:opacity-50"
                              >
                                {challengeBusy
                                  ? 'Requesting…'
                                  : expired || !hasCode
                                  ? 'Request a new verification code'
                                  : 'Request a different code'}
                              </button>
                            );
                          })()}
                        </>
                      )}
                    </motion.div>
                  )}

                  {/* Product Verification (SCRUM-25): identifier-free /
                      untracked listings. The seller can opt in to a
                      possession challenge directly from the listing page —
                      the backend lazily registers a possession identity
                      (no sensitive identifier required) and issues a
                      short-lived code. Rendered only once the identity
                      status has loaded so it never flashes during fetch. */}
                  {user && product.seller?._id === user._id && identity && !identity.tracked && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="border-t border-slate-200 pt-6"
                    >
                      <h3 className="font-semibold mb-1">Product Verification</h3>
                      <p className="text-sm text-slate-500 mb-3">
                        Verify physical possession of this product: request a short-lived code,
                        photograph the product beside it, and submit the code below. Buyers will
                        see that this listing has verified physical ownership.
                      </p>
                      <button
                        type="button"
                        onClick={handleRequestChallenge}
                        disabled={challengeBusy}
                        className="btn-secondary px-4 py-2 text-sm disabled:opacity-50"
                      >
                        {challengeBusy ? 'Requesting…' : 'Start possession verification'}
                      </button>
                    </motion.div>
                  )}
                </div>
              </ScrollReveal>

              {/* Similar Items */}
              {similar.length > 0 && (
                <ScrollReveal delay={0.2} direction="up">
                  <div className="card p-6">
                    <h3 className="font-display font-bold text-xl mb-4">Similar Items</h3>
                    <RevealOnScroll delay={0.05} className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {similar.slice(0, 4).map((s, i) => (
                        <ProductCard key={s._id} product={s} index={i} />
                      ))}
                    </RevealOnScroll>
                  </div>
                </ScrollReveal>
              )}
            </div>

            {/* Right: Actions + AI + Seller */}
            <div className="space-y-6">
              <ScrollReveal delay={0.1} direction="up">
                <div className="flex gap-2">
                  <motion.button
                    onClick={handleFavorite}
                    whileTap={{ scale: 0.95 }}
                    whileHover={{ scale: 1.02 }}
                    className={cn(
                      'flex-1 btn',
                      favorited
                        ? 'bg-accent-50 border border-accent-200 text-accent-700 hover:bg-accent-100'
                        : 'btn-secondary'
                    )}
                  >
                    <motion.div
                      animate={{
                        scale: favorited ? 1 : 0.8,
                        rotate: favorited ? 0 : -180,
                      }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    >
                      <Heart className={cn('w-4 h-4', favorited && 'fill-accent-500')} />
                    </motion.div>
                    {favorited ? 'Saved' : 'Save'}
                  </motion.button>
                  <motion.button
                    onClick={handleShare}
                    whileTap={{ scale: 0.95 }}
                    className="btn-secondary"
                    title="Share"
                    aria-label="Share listing"
                  >
                    <Share2 className="w-4 h-4" />
                  </motion.button>
                  <motion.button
                    onClick={() => setShowReport(true)}
                    whileTap={{ scale: 0.95 }}
                    className="btn-secondary"
                    title="Report"
                    aria-label="Report listing"
                  >
                    <Flag className="w-4 h-4" />
                  </motion.button>
                </div>
              </ScrollReveal>

              <ScrollReveal delay={0.15} direction="up">
                <AIAnalysisPanel aiAnalysis={product.aiAnalysis} currencyCode={product.currencyCode} />
              </ScrollReveal>

              <ScrollReveal delay={0.2} direction="up">
                <SellerInfo
                  seller={product.seller}
                  trust={trust}
                  onMessage={handleContactSeller}
                />
              </ScrollReveal>

              {/* Buyer-facing trust signals. Every item is shown only when
                  the backend actually reports that state — nothing is
                  labelled "verified" merely because a field exists. Internal
                  fraud scores and moderation details are never shown. */}
              <ScrollReveal delay={0.22} direction="up">
                <div className="card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <ShieldCheck className="w-4 h-4 text-brand-600" />
                    <span className="text-sm font-semibold text-slate-700">Trust & Verification</span>
                  </div>
                  <ul className="space-y-2 text-sm">
                    <li className="flex items-center gap-2">
                      {product.seller?.isVerified ? (
                        <>
                          <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                          <span className="text-slate-700">Seller is verified</span>
                        </>
                      ) : (
                        <>
                          <Info className="w-4 h-4 text-slate-400 flex-shrink-0" />
                          <span className="text-slate-500">Seller verification pending</span>
                        </>
                      )}
                    </li>
                    <li className="flex items-center gap-2">
                      {identity?.tracked && identity.provenance?.valid ? (
                        <>
                          <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                          <span className="text-slate-700">
                            Product identity registered — provenance history verified
                          </span>
                        </>
                      ) : identity?.tracked ? (
                        <>
                          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                          <span className="text-amber-600">
                            Product identity registered — provenance history could not be verified
                          </span>
                        </>
                      ) : (
                        <>
                          <Info className="w-4 h-4 text-slate-400 flex-shrink-0" />
                          <span className="text-slate-500">No product identity registered for this listing</span>
                        </>
                      )}
                    </li>
                    <li className="flex items-center gap-2">
                      {identity?.tracked && identity.verification?.possessionStatus === 'verified' ? (
                        <>
                          <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                          <span className="text-slate-700">
                            Possession verified by the seller (photo + code)
                          </span>
                        </>
                      ) : identity?.tracked ? (
                        <>
                          <Info className="w-4 h-4 text-slate-400 flex-shrink-0" />
                          <span className="text-slate-500">Possession not yet verified by the seller</span>
                        </>
                      ) : null}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                      <span className="text-slate-700">Reviews are written only by verified purchasers</span>
                    </li>
                  </ul>
                </div>
              </ScrollReveal>

              {product.status !== 'sold' && (
                <ScrollReveal delay={0.25} direction="up">
                  <motion.button
                    onClick={() => setShowOfferModal(true)}
                    whileTap={{ scale: 0.97 }}
                    whileHover={{ scale: 1.01 }}
                    className="w-full btn-secondary py-3 text-base"
                  >
                    <Tag className="w-5 h-5" />
                    Make an Offer
                  </motion.button>
                </ScrollReveal>
              )}

              <ScrollReveal delay={0.3} direction="up">
                <MagneticButton
                  onClick={handleContactSeller}
                  className="w-full btn-primary py-3 text-base"
                  strength={0.15}
                >
                  <MessageCircle className="w-5 h-5" />
                  Chat with Seller
                </MagneticButton>
              </ScrollReveal>

              {product.status === 'sold' && (
                <ScrollReveal delay={0.3} direction="up">
                  <div className="card p-4 text-center bg-slate-50 border-slate-300">
                    <ShieldCheck className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                    <p className="font-semibold text-slate-700">This item has been sold</p>
                  </div>
                </ScrollReveal>
              )}
            </div>
          </div>
        </div>

        {/* Product reviews — written by verified purchasers */}
        <ScrollReveal delay={0.2} direction="up">
          <ProductReviews
            productId={product._id}
            sellerId={product.seller?._id}
            data={reviewData}
            onRefresh={() => loadReviews(product._id)}
          />
        </ScrollReveal>

        <AnimatePresence>
          {showReport && (
            <ReportModal
              onClose={() => setShowReport(false)}
              onSubmit={handleReport}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showAddressModal && (
            <AddressModal
              product={product}
              initialValues={user ? { fullName: user.name || '' } : null}
              onConfirm={handleAddressConfirmed}
              onClose={() => setShowAddressModal(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showOfferModal && (
            <OfferModal
              product={product}
              onClose={() => setShowOfferModal(false)}
              onSubmit={handleOffer}
            />
          )}
        </AnimatePresence>

        {/* Sticky mobile action bar */}
        {product.status !== 'sold' && (
          <div className="lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/70 bg-white/90 px-4 py-3 backdrop-blur-xl shadow-[0_-8px_30px_-12px_rgba(15,23,42,0.25)] dark:border-white/10 dark:bg-slate-900/90">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowOfferModal(true)}
                className="btn-secondary flex-1 py-3"
              >
                <Tag className="w-5 h-5" />
                Offer
              </button>
              <MagneticButton
                onClick={handleContactSeller}
                className="flex-[1.4] btn-primary py-3"
                strength={0.15}
              >
                <MessageCircle className="w-5 h-5" />
                Chat with Seller
              </MagneticButton>
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  );
}

/**
 * Product reviews section. Reviews come from verified purchasers — the
 * backend only reveals the review form (`canReview.allowed`) to users
 * with a qualifying delivered/completed purchase, and re-verifies on
 * submission (the frontend hint is never proof of purchase).
 */
function ProductReviews({ productId, sellerId, data, onRefresh }) {
  const { reviews, summary, canReview } = data;
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!sellerId) return;
    setSubmitting(true);
    try {
      // Backend re-verifies the qualifying purchase for the authenticated
      // user — productId/sellerId here only identify the target.
      await sellerService.review(sellerId, { rating, comment, product: productId });
      toast.success('Review submitted');
      setComment('');
      onRefresh();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to submit review');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card p-6 mt-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-bold text-xl">Reviews</h3>
        {summary.count > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star
                  key={i}
                  className={`w-4 h-4 ${
                    i < Math.round(summary.average) ? 'fill-amber-400 text-amber-400' : 'text-slate-300'
                  }`}
                />
              ))}
            </div>
            <span className="text-sm text-slate-500">
              {summary.average} · {summary.count} review{summary.count === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>

      {canReview.allowed && (
        <form onSubmit={handleSubmit} className="mb-6 p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
          <p className="text-sm font-medium text-slate-700">Review your purchase</p>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRating(n)}
                aria-label={`Rate ${n} star${n === 1 ? '' : 's'}`}
                className="p-0.5"
              >
                <Star
                  className={`w-6 h-6 transition-colors ${
                    n <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300 hover:text-amber-300'
                  }`}
                />
              </button>
            ))}
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={1000}
            className="input"
            placeholder="How was the item and the seller?"
          />
          <button type="submit" disabled={submitting} className="btn-primary inline-flex items-center gap-2">
            <Send className="w-4 h-4" />
            {submitting ? 'Submitting...' : 'Submit Review'}
          </button>
        </form>
      )}

      {reviews.length === 0 ? (
        <p className="text-slate-500 text-sm">
          {canReview.reason === 'purchase_required'
            ? 'No reviews yet — only verified buyers can review this item'
            : 'No reviews yet'}
        </p>
      ) : (
        <div className="space-y-4">
          {reviews.map((r) => (
            <div key={r._id} className="border-b last:border-0 pb-4 last:pb-0">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      className={`w-4 h-4 ${
                        i < r.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-sm text-slate-500">{r.buyer?.name || 'Verified buyer'}</span>
                <span className="text-xs text-slate-400">{formatDate(r.createdAt)}</span>
              </div>
              {r.comment && <p className="text-sm text-slate-700">{r.comment}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddressModal({ product, initialValues, onConfirm, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 grid place-items-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-bold text-xl">Where should we deliver?</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100" type="button">
            <ChevronRight className="w-5 h-5 rotate-90" />
          </button>
        </div>
        <DeliveryAddressForm
          product={product}
          initialValues={initialValues}
          onConfirm={onConfirm}
          onCancel={onClose}
        />
      </motion.div>
    </div>
  );
}

function ReportModal({ onClose, onSubmit }) {
  const [reason, setReason] = useState('spam');
  const [description, setDescription] = useState('');

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 grid place-items-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="card p-6 w-full max-w-md"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-bold text-xl">Report Listing</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-100"
          >
            <ChevronRight className="w-5 h-5 rotate-90" />
          </button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSubmit({ reason, description }); }} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Reason</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)} className="input">
              <option value="spam">Spam</option>
              <option value="fake">Fake / Counterfeit</option>
              <option value="fraud">Fraud / Scam</option>
              <option value="inappropriate">Inappropriate</option>
              <option value="duplicate">Duplicate Listing</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Additional details</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="input"
              placeholder="Tell us what's wrong..."
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" className="btn-danger flex-1">Submit Report</button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

function OfferModal({ product, onClose, onSubmit }) {
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');
    const value = Number(amount);
    if (!amount || Number.isNaN(value) || value <= 0) {
      setError('Enter a valid offer amount');
      return;
    }
    if (value >= product.price) {
      setError('Offer must be below the listed price');
      return;
    }
    onSubmit({ amount: value, message });
  };

  const formatPrice = useFormatPrice(product?.currencyCode || 'USD');

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 grid place-items-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="offer-modal-title"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="card p-6 w-full max-w-md"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-600 to-accent-500 grid place-items-center">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <h3 id="offer-modal-title" className="font-display font-bold text-xl">Make an Offer</h3>
        </div>

        <div className="mb-5 p-4 rounded-xl bg-slate-50 border border-slate-200">
          <p className="text-xs text-slate-500 mb-1">Listed price</p>
          <p className="font-display font-bold text-2xl gradient-text">
            {formatPrice(product.price)}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="offer-amount" className="block text-sm font-medium mb-1">
              Your offer
            </label>
            <div className="relative">
              <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                id="offer-amount"
                type="number"
                min="1"
                step="1"
                max={product.price - 1}
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setError(''); }}
                placeholder="0"
                className="input pl-10"
                autoFocus
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="offer-message" className="block text-sm font-medium mb-1">
              Message <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <textarea
              id="offer-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={500}
              className="input"
              placeholder="Hi! Would you accept..."
            />
          </div>

          {error && (
            <p className="text-sm text-red-600" role="alert">{error}</p>
          )}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1">
              <Send className="w-4 h-4" />
              Submit Offer
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
