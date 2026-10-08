import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CreditCard, Loader2, Shield, ArrowLeft, Tag } from 'lucide-react';
import toast from 'react-hot-toast';
import { checkoutService, productService, offerService } from '../services/services';
import { useAuth } from '../contexts/AuthContext';
import useFormatPrice from '../hooks/useFormatPrice';
import DeliveryAddressForm from '../components/checkout/DeliveryAddressForm';
import PageTransition from '../components/layout/PageTransition';
import Loader from '../components/ui/Loader';
import { PRODUCT_FALLBACK_IMAGE, handleImageError } from '../utils/imageFallback';

export default function Checkout() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const offerId = searchParams.get('offer');
  const navigate = useNavigate();
  const { user } = useAuth();
  const [product, setProduct] = useState(null);
  const [offer, setOffer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState('address'); // address | review | processing
  const [address, setAddress] = useState(null);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    productService.get(id).then((r) => {
      setProduct(r.data.product);
      setLoading(false);
    }).catch(() => {
      toast.error('Product not found');
      navigate('/marketplace');
    });
  }, [id]);

  // Load the accepted offer so the negotiated amount can be shown.
  // The backend re-validates the offer and sets the real Stripe charge —
  // this display amount never determines what the buyer is charged.
  useEffect(() => {
    if (!offerId) return;
    offerService.get(offerId)
      .then((r) => {
        const o = r.data.offer;
        if (o.status !== 'accepted') {
          toast.error('This offer is no longer accepted — paying list price');
          return;
        }
        setOffer(o);
      })
      .catch(() => toast.error('Could not load your offer — paying list price'));
  }, [offerId]);

  const itemPrice = offer ? offer.amount : product?.price || 0;
  const platformFee = Math.round(itemPrice * 0.05);
  const total = itemPrice + platformFee;
  const formatPrice = useFormatPrice(product?.currencyCode || 'USD');

  const handleAddressConfirm = (addr) => {
    setAddress(addr);
    setStep('review');
  };

  const handlePurchase = async () => {
    setProcessing(true);
    try {
      const { data } = await checkoutService.createSession({
        productId: id,
        shippingAddress: address,
        ...(offer ? { offerId: offer._id } : {}),
      });
      // Redirect to Stripe Checkout
      window.location.href = data.url;
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to start checkout';
      toast.error(msg);
      setProcessing(false);
      setStep('review');
    }
  };

  if (loading) return <Loader />;

  return (
    <PageTransition>
      <div className="container-page py-8 max-w-2xl mx-auto">
        <motion.button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 mb-6"
          whileTap={{ scale: 0.95 }}
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </motion.button>

        <h1 className="font-display text-2xl font-bold mb-6">Checkout</h1>

        {step === 'address' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <DeliveryAddressForm
              product={product}
              onConfirm={handleAddressConfirm}
              onCancel={() => navigate(-1)}
            />
          </motion.div>
        )}

        {step === 'review' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <div className="card p-6 space-y-4">
              <h2 className="font-semibold text-lg">Order Summary</h2>
              <div className="flex items-start gap-4">
                <img
                  src={product.images?.[0]?.url || PRODUCT_FALLBACK_IMAGE}
                  alt=""
                  className="w-20 h-20 rounded-lg object-cover bg-slate-100 flex-shrink-0"
                  onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
                />
                <div className="flex-1">
                  <p className="font-medium">{product.title}</p>
                  <p className="text-sm text-slate-500">{product.category?.name}</p>
                  {offer && (
                    <p className="text-xs text-emerald-600 mt-1 inline-flex items-center gap-1">
                      <Tag className="w-3 h-3" /> Accepted offer applied
                    </p>
                  )}
                </div>
                <p className="font-semibold">{formatPrice(itemPrice)}</p>
              </div>

              <div className="border-t border-slate-100 pt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Item price</span>
                  <span>{formatPrice(itemPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Platform fee (5%)</span>
                  <span>{formatPrice(platformFee)}</span>
                </div>
                <div className="flex justify-between font-semibold text-base border-t border-slate-100 pt-2">
                  <span>Total</span>
                  <span>{formatPrice(total)}</span>
                </div>
              </div>
            </div>

            {address && (
              <div className="card p-4">
                <p className="text-xs text-slate-500 mb-1">Delivering to</p>
                <p className="text-sm font-medium">{address.fullName}</p>
                <p className="text-sm text-slate-600">
                  {address.line1}, {address.city}, {address.country}
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => setStep('address')} className="btn-secondary flex-1">
                Edit Address
              </button>
              <button
                onClick={handlePurchase}
                disabled={processing}
                className="btn-primary flex-1 flex items-center justify-center gap-2"
              >
                {processing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CreditCard className="w-4 h-4" />
                )}
                Pay with Stripe
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-400 justify-center">
              <Shield className="w-3 h-3" />
              <span>Payments are processed securely by Stripe</span>
            </div>
          </motion.div>
        )}
      </div>
    </PageTransition>
  );
}
