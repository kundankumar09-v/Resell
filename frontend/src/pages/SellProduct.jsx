import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload,
  X,
  Sparkles,
  Check,
  TrendingUp,
  Shield,
  Camera,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Tag,
  Image,
  DollarSign,
  Hash,
  Bot,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { productService, categoryService } from '../services/services';
import { formatPrice, getConditionLabel, cn } from '../utils/format';
import PageTransition from '../components/layout/PageTransition';
import { TiltCard } from '../components/ui/TiltCard';
import MagneticButton from '../components/ui/MagneticButton';
import { ScrollReveal, RevealOnScroll } from '../components/ui/ScrollReveal';
import { useCurrency } from '../contexts/CurrencyContext';
import { SUPPORTED_CURRENCIES, convertPrice } from '../utils/currency';
import LocationDetectButton from '../components/ui/LocationDetectButton';
import useLocationDetector from '../hooks/useLocationDetector';
import { imageGuidanceFor, MIN_IMAGES, RECOMMENDED_IMAGES, MAX_IMAGES } from '../utils/imageGuidance';

const STEPS = [
  { id: 'photos', label: 'Photos', icon: Image },
  { id: 'details', label: 'Details', icon: Hash },
  { id: 'ai', label: 'AI Analysis', icon: Sparkles },
  { id: 'review', label: 'Review', icon: Check },
];

const toNumber = (value) => {
  if (value === '' || value === null || value === undefined) return NaN;
  const trimmed = String(value).trim();
  if (trimmed === '') return NaN;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : NaN;
};

const toInt = (value) => {
  if (value === '' || value === null || value === undefined) return 0;
  const trimmed = String(value).trim();
  if (trimmed === '') return 0;
  // parseInt handles "02" -> 2 correctly
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : NaN;
};

export default function SellProduct() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const [step, setStep] = useState(0);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [images, setImages] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const { rates } = useCurrency();
  const [selectedCurrency, setSelectedCurrency] = useState('INR');
  const locationDetector = useLocationDetector();

  const [form, setForm] = useState({
    title: '',
    description: '',
    price: '',
    originalPrice: '',
    category: '',
    brand: '',
    model: '',
    condition: 'good',
    yearsUsed: 0,
    specifications: [],
    location: { city: '', state: '', country: '' },
    identifier: '',
    identifierType: 'serial',
  });
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [identityStatus, setIdentityStatus] = useState(null);
  const [priceSuggestion, setPriceSuggestion] = useState(null);
  const [categoryAutoFilled, setCategoryAutoFilled] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  // Post-submit: the created product's ID and worker suggestion polling state
  const [createdProductId, setCreatedProductId] = useState(null);
  const [workerSuggestion, setWorkerSuggestion] = useState(null); // { category, confidence, categoryId } | null
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [suggestionPolling, setSuggestionPolling] = useState(false);
  const pollTimerRef = useRef(null);
  const pollCountRef = useRef(0);
  // Multi-object state (README §7.12): bounding boxes from the worker's
  // cover-image detection, seller-picked primary override.
  const [multiObjects, setMultiObjects] = useState([]);
  const [multiObjectDims, setMultiObjectDims] = useState({ w: 0, h: 0 });
  const [isMultiObject, setIsMultiObject] = useState(false);
  const [serverPrimaryIdx, setServerPrimaryIdx] = useState(null);
  const [selectedPrimaryIdx, setSelectedPrimaryIdx] = useState(null);
  const [primarySaving, setPrimarySaving] = useState(false);

  const currencyMeta = SUPPORTED_CURRENCIES.find((c) => c.code === selectedCurrency) || SUPPORTED_CURRENCIES.find((c) => c.code === 'INR');
  const selectedCategory = categories.find((c) => c._id === form.category);
  const identifierRequired = !!selectedCategory?.requiresIdentifier;

  const handleCurrencyChange = useCallback((newCurrency) => {
    if (newCurrency === selectedCurrency) return;
    // Prevent double conversion: convert displayed values from old to new
    if (rates) {
      setForm((prev) => {
        const next = { ...prev };
        const priceNum = toNumber(prev.price);
        if (!Number.isNaN(priceNum) && prev.price !== '') {
          const converted = convertPrice(priceNum, selectedCurrency, newCurrency, rates);
          next.price = String(Math.round(converted * 100) / 100);
        }
        const origNum = toNumber(prev.originalPrice);
        if (!Number.isNaN(origNum) && prev.originalPrice !== '') {
          const convertedOrig = convertPrice(origNum, selectedCurrency, newCurrency, rates);
          next.originalPrice = String(Math.round(convertedOrig * 100) / 100);
        }
        return next;
      });
    }
    setSelectedCurrency(newCurrency);
  }, [selectedCurrency, rates]);

  useEffect(() => {
    categoryService.list().then((r) => setCategories(r.data.categories)).catch(() => {});
  }, []);

  // ── Worker suggestion polling ────────────────────────────────────────────────
  // After listing creation, poll GET /products/:id every 2s for up to 30s waiting
  // for the imageProcessor worker to write aiAnalysis.classification.predictedCategory.
  const startPolling = useCallback((productId, currentCategoryId) => {
    setSuggestionPolling(true);
    pollCountRef.current = 0;
    const MAX_POLLS = 15; // 2s * 15 = 30s

    const poll = async () => {
      try {
        const { data } = await productService.get(productId);
        const predicted = data.product?.aiAnalysis?.classification?.predictedCategory;
        const confidence = data.product?.aiAnalysis?.classification?.confidence;
        const ai = data.product?.aiAnalysis || {};

        // Multi-object detections (cover image): capture boxes + primary for overlays.
        if (Array.isArray(ai.detectedObjects) && ai.detectedObjects.length > 0) {
          setMultiObjects(ai.detectedObjects);
          setIsMultiObject(!!ai.multiObject);
          setMultiObjectDims({
            w: ai.detectedImageWidth || 0,
            h: ai.detectedImageHeight || 0,
          });
          const srvIdx = Number.isInteger(ai.primaryObjectIndex) ? ai.primaryObjectIndex : 0;
          setServerPrimaryIdx(srvIdx);
          setSelectedPrimaryIdx((prev) => (prev === null ? srvIdx : prev));
        }

        if (predicted && predicted !== '') {
          // Worker has finished — find matching category
          const matched = categories.find(
            (c) => c.name.toLowerCase() === predicted.toLowerCase()
          );
          setSuggestionPolling(false);
          setWorkerSuggestion({
            category: predicted,
            confidence: confidence || 0,
            categoryId: matched?._id || null,
          });
          return;
        }
      } catch {
        // Polling errors are silent — network hiccup, retry
      }

      pollCountRef.current += 1;
      if (pollCountRef.current < MAX_POLLS) {
        pollTimerRef.current = setTimeout(poll, 2000);
      } else {
        // Timeout — worker didn't respond (likely Redis off)
        setSuggestionPolling(false);
        setWorkerSuggestion({ category: null, confidence: 0, categoryId: null });
      }
    };

    pollTimerRef.current = setTimeout(poll, 2000);
  }, [categories]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
  }, []);

  // Auto-fill category from image classification prediction
  useEffect(() => {
    if (aiAnalysis?.predictedCategory && categories.length > 0 && !categoryAutoFilled && !form.category) {
      const predicted = categories.find(
        (c) => c.name.toLowerCase() === aiAnalysis.predictedCategory.toLowerCase()
      );
      if (predicted && aiAnalysis.classificationConfidence >= 0.3) {
        setForm((prev) => ({ ...prev, category: predicted._id }));
        setCategoryAutoFilled(true);
        toast.success(`Category auto-detected: ${predicted.name}`);
      }
    }
  }, [aiAnalysis, categories, categoryAutoFilled, form.category]);

  // Fetch price suggestion when category/condition/brand change - send INR to API
  useEffect(() => {
    if (!form.category || !form.condition) {
      setPriceSuggestion(null);
      return;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      // Convert originalPrice to INR before sending to API
      let originalPriceForApi;
      const origNum = toNumber(form.originalPrice);
      if (!Number.isNaN(origNum) && form.originalPrice !== '') {
        originalPriceForApi = rates ? convertPrice(origNum, selectedCurrency, 'INR', rates) : origNum;
      } else {
        originalPriceForApi = undefined;
      }
      const yearsUsedNum = toInt(form.yearsUsed);
      productService.suggestPrice({
        category: form.category,
        condition: form.condition,
        brand: form.brand || undefined,
        originalPrice: originalPriceForApi,
        yearsUsed: Number.isFinite(yearsUsedNum) ? yearsUsedNum : undefined,
      }).then((r) => setPriceSuggestion(r.data)).catch(() => {});
    }, 500); // debounce 500ms
    return () => { clearTimeout(timeoutId); controller.abort(); };
  }, [form.category, form.condition, form.brand, form.originalPrice, form.yearsUsed, selectedCurrency, rates]);

  const handleLocationDetect = async () => {
    const result = await locationDetector.detect();
    if (result && result.raw) {
      const addr = result.raw;
      const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || '';
      const state = addr.state || addr.state_district || addr.region || '';
      const country = addr.country || '';
      setForm((prev) => ({
        ...prev,
        location: {
          city: city || prev.location.city,
          state: state || prev.location.state,
          country: country || prev.location.country,
        },
      }));
      if (city || country) {
        toast.success(`Location detected: ${[city, state, country].filter(Boolean).join(', ')}`);
      }
    }
  };

  const processFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (images.length + files.length > MAX_IMAGES) {
      toast.error(`Maximum ${MAX_IMAGES} images allowed`);
      return;
    }

    // Client-side validation (the server re-validates): image type + size
    const invalidType = files.find((f) => !f.type?.startsWith('image/'));
    if (invalidType) {
      toast.error(`"${invalidType.name}" is not an image file. Only image files are allowed.`);
      return;
    }
    const tooLarge = files.find((f) => f.size > 10 * 1024 * 1024);
    if (tooLarge) {
      toast.error(`"${tooLarge.name}" is larger than 10MB. Please use a smaller image.`);
      return;
    }

    setUploading(true);
    const formData = new FormData();
    files.forEach((f) => formData.append('images', f));
    if (form.title) formData.append('title', form.title);

    try {
      const { data } = await productService.uploadImages(formData);
      setImages((prev) => [...prev, ...data.images]);
      if (data.analysis) {
        setAiAnalysis((prev) => ({
          ...prev,
          conditionScore: data.analysis.conditionScore,
          damageScore: data.analysis.damageScore,
          predictedCategory: data.analysis.predictedCategory,
          classificationConfidence: data.analysis.classificationConfidence,
        }));
      }
      toast.success(`${data.images.length} image(s) analyzed`);
    } catch (err) {
      if (err.response?.status === 409) {
        toast.error(err.response?.data?.message || 'This image is already used in another listing. Please use a different photo.');
      } else {
        toast.error(err.response?.data?.message || 'Failed to upload images');
      }
    } finally {
      setUploading(false);
    }
  };

  const handleImageUpload = async (e) => {
    await processFiles(e.target.files);
    // reset input so same file can be selected again if needed
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragActive(false);
    if (uploading) return;
    await processFiles(e.dataTransfer?.files);
  };

  const removeImage = (idx) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const addSpec = () => {
    setForm((prev) => ({ ...prev, specifications: [...prev.specifications, { key: '', value: '' }] }));
  };

  const updateSpec = (idx, key, value) => {
    setForm((prev) => ({
      ...prev,
      specifications: prev.specifications.map((s, i) => (i === idx ? { key, value } : s)),
    }));
  };

  const removeSpec = (idx) => {
    setForm((prev) => ({
      ...prev,
      specifications: prev.specifications.filter((_, i) => i !== idx),
    }));
  };

  const canProceed = () => {
    // Minimum 3 images (multi-angle requirement) — the server re-validates
    if (step === 0) return images.length >= MIN_IMAGES && !uploading;
    if (step === 1) return form.title && form.description && form.price && form.category;
    return true;
  };

  const getDisplayPrice = (amountInINR) => {
    if (amountInINR === null || amountInINR === undefined) return '—';
    if (!rates || selectedCurrency === 'INR') return formatPrice(amountInINR, 'INR');
    const converted = convertPrice(amountInINR, 'INR', selectedCurrency, rates);
    return formatPrice(converted, selectedCurrency);
  };

  const applySuggestedPrice = () => {
    if (!priceSuggestion || !priceSuggestion.suggestedPrice) return;
    const inrPrice = priceSuggestion.suggestedPrice;
    let converted = inrPrice;
    if (rates && selectedCurrency !== 'INR') {
      converted = convertPrice(inrPrice, 'INR', selectedCurrency, rates);
    }
    const val = String(Math.round(converted * 100) / 100);
    setForm((prev) => ({ ...prev, price: val }));
    toast.success(`Applied suggested price: ${currencyMeta.symbol}${val}`);
  };

  const handleSubmit = async () => {
    if (loading) return; // prevent double click
    if (images.length < MIN_IMAGES) {
      toast.error(
        `Please upload at least ${MIN_IMAGES} images: a front/main view, a back view and a side or detail view. Recommended: ${RECOMMENDED_IMAGES}.`
      );
      return;
    }
    if (uploading) {
      toast.error('Please wait for image upload to complete');
      return;
    }

    // Validate required fields
    setSubmitAttempted(true);
    if (!form.title.trim()) { toast.error('Title is required'); return; }
    if (!form.description.trim()) { toast.error('Description is required'); return; }
    if (!form.category) { toast.error('Category is required'); return; }

    const priceNum = toNumber(form.price);
    if (Number.isNaN(priceNum)) { toast.error('Price must be a valid number'); return; }
    if (priceNum < 0) { toast.error('Price cannot be negative'); return; }

    let originalPriceNum = 0;
    if (form.originalPrice !== '' && form.originalPrice !== null) {
      const origParsed = toNumber(form.originalPrice);
      if (Number.isNaN(origParsed)) { toast.error('Original price must be a valid number'); return; }
      if (origParsed < 0) { toast.error('Original price cannot be negative'); return; }
      originalPriceNum = origParsed;
    }

    const yearsUsedNum = toInt(form.yearsUsed);
    if (Number.isNaN(yearsUsedNum)) { toast.error('Years used must be a valid number'); return; }
    if (yearsUsedNum < 0) { toast.error('Years used cannot be negative'); return; }

    // Identifier validation (mirrors the backend normalization rules — the
    // server re-validates and hashes; the raw value is never stored)
    const rawIdentifier = form.identifier?.trim();
    if (rawIdentifier) {
      const cleaned = rawIdentifier.replace(/[\s\-_.]/g, '');
      const type = form.identifierType;
      if (type === 'imei' && !/^\d{15}$/.test(cleaned)) {
        toast.error('IMEI must be exactly 15 digits'); return;
      }
      if (type === 'vin' && !/^[A-Z0-9]{17}$/.test(cleaned.toUpperCase())) {
        toast.error('VIN must be exactly 17 letters and numbers'); return;
      }
      if (type === 'serial' && cleaned.length < 4) {
        toast.error('Serial number must be at least 4 characters'); return;
      }
    }

    // Convert display currency to INR for storage
    const priceInINR = rates ? convertPrice(priceNum, selectedCurrency, 'INR', rates) : priceNum;
    const originalPriceInINR = rates ? convertPrice(originalPriceNum, selectedCurrency, 'INR', rates) : originalPriceNum;

    if (!Number.isFinite(priceInINR) || !Number.isFinite(originalPriceInINR)) {
      toast.error('Currency conversion failed. Please try again.');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim(),
        price: Math.round(priceInINR * 100) / 100,
        originalPrice: Math.round(originalPriceInINR * 100) / 100,
        currencyCode: 'INR',
        category: form.category,
        brand: form.brand?.trim() || '',
        model: form.model?.trim() || '',
        condition: form.condition,
        yearsUsed: yearsUsedNum,
        location: {
          city: form.location.city?.trim() || '',
          state: form.location.state?.trim() || '',
          country: form.location.country?.trim() || '',
        },
        images: images.map((img) => ({
          url: img.url,
          publicId: img.publicId,
          hash: img.hash,
        })),
        specifications: form.specifications.filter((s) => s.key?.trim() && s.value?.trim()).map((s) => ({ key: s.key.trim(), value: s.value.trim() })),
        ...(form.identifier?.trim() ? { identifier: form.identifier.trim(), identifierType: form.identifierType } : {}),
      };

      const { data } = await productService.create(payload);
      if (data.identityStatus) {
        setIdentityStatus(data.identityStatus);
        for (const warning of data.identityStatus.warnings || []) {
          toast.error(warning);
        }
        if (data.identityStatus.verification?.verificationCode) {
          toast.success(
            `Ownership tracking enabled. Upload a photo of the physical product showing code ${data.identityStatus.verification.verificationCode} (and the serial/IMEI where possible) on the product page to verify possession. Code valid for 24 hours.`
          );
        }
      }
      toast.success('Listing published!');
      // Start polling for worker AI category suggestion instead of navigating immediately
      const pid = data.product._id;
      setCreatedProductId(pid);
      startPolling(pid, form.category);
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.message;
      if (status === 400) toast.error(msg || 'Please check your input and try again.');
      else if (status === 401) toast.error(msg || 'Please log in again.');
      else if (status === 403) toast.error(msg || 'Not authorized.');
      else if (status === 409) toast.error(msg || 'Duplicate listing detected.');
      else if (status === 422) toast.error(msg || 'Validation failed.');
      else if (status === 500) toast.error(msg || 'Server error. Please try again later.');
      else if (!err.response) toast.error('Network error. Please check your connection.');
      else toast.error(msg || 'Failed to create listing');
    } finally {
      setLoading(false);
    }
  };

  // ── Apply AI suggestion ──────────────────────────────────────────────────────
  const applyWorkerSuggestion = async () => {
    if (!createdProductId || !workerSuggestion?.categoryId) return;
    try {
      await productService.update(createdProductId, { category: workerSuggestion.categoryId });
      toast.success(`Category updated to ${workerSuggestion.category}`);
    } catch {
      toast.error('Could not apply suggestion — you can edit it from the product page.');
    } finally {
      navigate(`/product/${createdProductId}`);
    }
  };

  // ── Apply primary object ───────────────────────────────────────────────────
  // Seller clicked a bounding box: persist the override, then refresh the
  // category suggestion (the backend re-points it at the chosen crop).
  const applyPrimaryObject = async () => {
    if (!createdProductId || selectedPrimaryIdx === null || selectedPrimaryIdx === serverPrimaryIdx) return;
    setPrimarySaving(true);
    try {
      await productService.update(createdProductId, { primaryObjectIndex: selectedPrimaryIdx });
      const { data } = await productService.get(createdProductId);
      const ai = data.product?.aiAnalysis || {};
      const predicted = ai.classification?.predictedCategory;
      if (predicted) {
        const matched = categories.find(
          (c) => c.name.toLowerCase() === predicted.toLowerCase()
        );
        setWorkerSuggestion({
          category: predicted,
          confidence: ai.classification?.confidence || 0,
          categoryId: matched?._id || null,
        });
      }
      setServerPrimaryIdx(Number.isInteger(ai.primaryObjectIndex) ? ai.primaryObjectIndex : selectedPrimaryIdx);
      toast.success('Primary item updated — AI suggestion refreshed');
    } catch {
      toast.error('Could not update the primary item. Please try again.');
    } finally {
      setPrimarySaving(false);
    }
  };

  // ── Post-submit state: show AI suggestion polling card ───────────────────────
  if (createdProductId) {
    const selectedCat = categories.find((c) => c._id === form.category);
    const suggestion = workerSuggestion?.category;
    const confidence = workerSuggestion?.confidence || 0;
    const isSameAsSelected =
      suggestion &&
      selectedCat &&
      suggestion.toLowerCase() === selectedCat.name.toLowerCase();

    return (
      <PageTransition>
        <div className="relative min-h-screen">
          <div className="container-page py-8 md:py-12 max-w-4xl relative z-10">
            <ScrollReveal direction="up">
              <div className="mb-8 text-center">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 grid place-items-center mb-4"
                >
                  <Check className="w-10 h-10 text-white" />
                </motion.div>
                <h1 className="font-display font-bold text-3xl mb-2">Listing Published! 🎉</h1>
                <p className="text-slate-500">Your item is live on the marketplace.</p>
              </div>
            </ScrollReveal>

            {/* AI Suggestion Banner */}
            <AnimatePresence mode="wait">
              {!suggestionDismissed && (
                <motion.div
                  key="suggestion-card"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="card p-6 mb-6 bg-gradient-to-br from-brand-50 to-accent-50 border-brand-100"
                >
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-600 to-accent-500 grid place-items-center flex-shrink-0">
                      <Bot className="w-6 h-6 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      {suggestionPolling ? (
                        <>
                          <div className="flex items-center gap-2 mb-1">
                            <Loader2 className="w-4 h-4 animate-spin text-brand-600" />
                            <span className="font-semibold text-sm text-brand-700">AI is analyzing your photos…</span>
                          </div>
                          <p className="text-xs text-slate-500">The category suggestion will appear here in a few seconds. Worker is processing images.</p>
                        </>
                      ) : suggestion ? (
                        <>
                          <p className="font-semibold text-sm text-brand-700 mb-0.5">
                            {isSameAsSelected
                              ? `🤖 AI agrees: ${suggestion}`
                              : selectedCat
                              ? `🤖 AI thinks this is ${suggestion} — you picked ${selectedCat.name}`
                              : `🤖 AI suggests: ${suggestion}`}
                            {confidence > 0 && (
                              <span className="ml-2 text-xs font-normal text-slate-400">
                                ({Math.round(confidence * 100)}% confident)
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-slate-500 mb-4">
                            {isSameAsSelected
                              ? 'Your selected category matches the AI prediction — great choice!'
                              : 'You can apply the AI suggestion or keep your original selection.'}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {!isSameAsSelected && workerSuggestion?.categoryId && (
                              <button
                                id="ai-suggestion-apply"
                                onClick={applyWorkerSuggestion}
                                className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold shadow-sm transition-all"
                              >
                                Apply — change to {suggestion}
                              </button>
                            )}
                            <button
                              id="ai-suggestion-dismiss"
                              onClick={() => {
                                setSuggestionDismissed(true);
                                navigate(`/product/${createdProductId}`);
                              }}
                              className="px-4 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-semibold transition-all"
                            >
                              {isSameAsSelected ? 'View listing →' : 'Keep my selection'}
                            </button>
                          </div>
                          {!isSameAsSelected && workerSuggestion?.categoryId && (
                            <p className="text-[11px] text-slate-400 mt-3" id="ai-suggestion-reanalysis-note">
                              Applying re-runs AI analysis — the listing is re-scored with your new category.
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="font-semibold text-sm text-slate-700 mb-0.5">AI analysis not available</p>
                          <p className="text-xs text-slate-500 mb-4">
                            The AI worker did not return a category suggestion (Redis may be off, or the worker is not running).
                            Your listing is live and the category you selected has been saved.
                          </p>
                          <button
                            id="ai-suggestion-continue"
                            onClick={() => navigate(`/product/${createdProductId}`)}
                            className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold shadow-sm transition-all"
                          >
                            View listing →
                          </button>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => { setSuggestionDismissed(true); navigate(`/product/${createdProductId}`); }}
                      className="text-slate-400 hover:text-slate-600 transition flex-shrink-0"
                      aria-label="Dismiss suggestion"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Multi-object picker (README §7.12) */}
            {isMultiObject && multiObjects.length >= 2 && (
              <motion.div
                key="multi-object-card"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="card p-6 mb-6"
                id="multi-object-picker"
              >
                <p className="font-semibold text-sm text-slate-800 mb-1">
                  🤖 We found {multiObjects.length} items in your cover photo
                </p>
                <p className="text-xs text-slate-500 mb-4">
                  Click the item you're selling to make it the primary — the AI category
                  suggestion and similarity search will follow that item.
                </p>
                <div className="relative rounded-xl overflow-hidden border border-slate-200 inline-block max-w-full">
                  {images[0]?.url && (
                    <img src={images[0].url} alt="Cover with detected items" className="max-h-96 w-auto" />
                  )}
                  {(() => {
                    const baseW = multiObjectDims.w || images[0]?.width || 0;
                    const baseH = multiObjectDims.h || images[0]?.height || 0;
                    if (!baseW || !baseH) return null;
                    return multiObjects.map((obj, idx) => {
                      const b = obj.bbox || {};
                      const isPrimary = (selectedPrimaryIdx ?? serverPrimaryIdx ?? 0) === idx;
                      const label = `${obj.label || 'Item'} ${Math.round((obj.score || 0) * 100)}%`;
                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => setSelectedPrimaryIdx(idx)}
                          aria-label={`Select ${label} as primary item`}
                          className={cn(
                            'absolute border-2 rounded-sm transition-all',
                            isPrimary
                              ? 'border-emerald-500 bg-emerald-500/10'
                              : 'border-brand-500 bg-brand-500/10 hover:bg-brand-500/20'
                          )}
                          style={{
                            left: `${((b.x || 0) / baseW) * 100}%`,
                            top: `${((b.y || 0) / baseH) * 100}%`,
                            width: `${((b.width || 0) / baseW) * 100}%`,
                            height: `${((b.height || 0) / baseH) * 100}%`,
                          }}
                        >
                          <span
                            className={cn(
                              'absolute -top-6 left-0 whitespace-nowrap text-[11px] font-semibold px-1.5 py-0.5 rounded text-white',
                              isPrimary ? 'bg-emerald-600' : 'bg-brand-600'
                            )}
                          >
                            {label}{isPrimary ? ' ✓' : ''}
                          </span>
                        </button>
                      );
                    });
                  })()}
                </div>
                <div className="flex flex-wrap gap-2 mt-4">
                  <button
                    type="button"
                    onClick={applyPrimaryObject}
                    disabled={primarySaving || selectedPrimaryIdx === null || selectedPrimaryIdx === serverPrimaryIdx}
                    className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-semibold shadow-sm transition-all"
                  >
                    {primarySaving ? 'Saving…' : 'Set as primary item'}
                  </button>
                </div>
              </motion.div>
            )}
          </div>
        </div>
      </PageTransition>
    );
  }

  return (
    <PageTransition>
      <div className="relative min-h-screen">

        <div className="container-page py-8 md:py-12 max-w-4xl relative z-10">
          <ScrollReveal direction="up">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-10"
            >
              <h1 className="font-display font-bold text-3xl md:text-4xl mb-2">List Your Item</h1>
              <p className="text-slate-500">Our AI will analyze your images and suggest the optimal price.</p>
            </motion.div>
          </ScrollReveal>

          {/* Stepper */}
          <ScrollReveal delay={0.1} direction="up">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-10"
            >
              <div className="flex items-center justify-between mb-4">
                {STEPS.map((s, i) => (
                  <div key={s.id} className="flex-1 flex items-center">
                    <motion.div
                      className={cn(
                        'w-12 h-12 rounded-full grid place-items-center font-semibold transition-all',
                        i < step
                          ? 'bg-gradient-to-br from-brand-500 to-brand-600 text-white shadow-lg shadow-brand-500/30'
                          : i === step
                          ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/30'
                          : 'bg-slate-200 text-slate-500'
                      )}
                      animate={{
                        scale: i <= step ? 1 : 0.9,
                      }}
                      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                    >
                      {i < step ? <Check className="w-5 h-5" /> : i + 1}
                    </motion.div>
                    {i < STEPS.length - 1 && (
                      <motion.div
                        className="flex-1 h-1 mx-2 bg-slate-200 rounded overflow-hidden"
                        initial={{ width: 0 }}
                        animate={{ width: i < step ? '100%' : '0%' }}
                        transition={{ delay: 0.2, duration: 0.3 }}
                      >
                        <motion.div
                          className="h-full bg-brand-500 rounded"
                          initial={{ width: 0 }}
                          animate={{ width: i < step ? '100%' : '0%' }}
                          transition={{ delay: 0.2, duration: 0.3 }}
                        />
                      </motion.div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-xs text-slate-500">
                {STEPS.map((s, i) => (
                  <motion.span
                    key={s.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 + i * 0.1 }}
                    className={cn(i === step && 'font-semibold text-brand-600')}
                  >
                    {s.label}
                  </motion.span>
                ))}
              </div>
              <div className="mt-3 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500"
                  initial={false}
                  animate={{ width: `${(step / (STEPS.length - 1)) * 100}%` }}
                  transition={{ type: 'spring', stiffness: 260, damping: 30 }}
                />
              </div>
              <p className="mt-2 text-center text-xs text-slate-400">
                Step {step + 1} of {STEPS.length}
              </p>
            </motion.div>
          </ScrollReveal>

          <AnimatePresence mode="wait">
            {/* STEP 0: IMAGES */}
            {step === 0 && (
              <motion.div
                key="step0"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.3 }}
                className="space-y-6"
              >
                <ScrollReveal direction="up">
                  <TiltCard maxTilt={4} className="card p-6">
                    <div className="mb-6">
                      <h3 className="font-display font-bold text-lg mb-1">Upload Photos</h3>
                      <p className="text-sm text-slate-500">
                        At least {MIN_IMAGES} images are required (recommended {RECOMMENDED_IMAGES}, max {MAX_IMAGES}). The first image will be the cover.
                      </p>
                    </div>

                    {/* Multi-angle guidance — category-specific when possible */}
                    <div className="mb-6 p-4 rounded-xl bg-slate-50 border border-slate-200">
                      <div className="flex items-center gap-2 mb-2">
                        <Camera className="w-4 h-4 text-brand-500" />
                        <span className="text-sm font-medium text-slate-700">
                          Recommended photos{selectedCategory ? ` for ${selectedCategory.name}` : ''}
                        </span>
                      </div>
                      <ol className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-slate-600 list-decimal list-inside">
                        {imageGuidanceFor(selectedCategory?.name).map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ol>
                      <p className="text-xs text-slate-400 mt-2">
                        Multiple angles help buyers verify the item and speed up verification.
                      </p>
                    </div>

                    <div
                      onClick={() => !uploading && fileInputRef.current?.click()}
                      onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragActive(true); }}
                      onDragLeave={() => setDragActive(false)}
                      onDrop={handleDrop}
                      className={cn(
                        "border-2 border-dashed rounded-2xl p-12 text-center transition-all group",
                        uploading
                          ? "opacity-70 cursor-not-allowed border-slate-300"
                          : dragActive
                          ? "border-brand-500 bg-brand-50/70 dark:bg-brand-500/10 scale-[1.01] shadow-soft-lg cursor-copy"
                          : "border-slate-300 hover:border-brand-400 hover:bg-brand-50/30 cursor-pointer"
                      )}
                    >
                      {uploading ? (
                        <motion.div className="flex flex-col items-center gap-3">
                          <Loader2 className="w-12 h-12 animate-spin text-brand-500" />
                          <p className="font-medium text-slate-700">Analyzing images...</p>
                          <p className="text-xs text-slate-500">This may take a moment on first upload</p>
                        </motion.div>
                      ) : (
                        <>
                          <motion.div
                            whileHover={{ scale: 1.1, rotate: 180 }}
                            className="w-16 h-16 mx-auto text-slate-400 mb-4"
                          >
                            <Upload className="w-16 h-16" />
                          </motion.div>
                          <p className="font-medium text-slate-700">
                            {dragActive ? 'Drop your images here' : 'Click or drag images to upload'}
                          </p>
                          <p className="text-sm text-slate-500 mt-1">PNG, JPG up to 10MB each</p>
                        </>
                      )}
                    </div>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageUpload}
                      className="hidden"
                    />

                    {images.length > 0 && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
                        {images.map((img, i) => (
                          <motion.div
                            key={i}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: i * 0.05 }}
                            className="relative group aspect-square rounded-xl overflow-hidden"
                          >
                            <img src={img.url} alt="" className="w-full h-full object-cover" />
                            <motion.button
                              onClick={() => removeImage(i)}
                              whileHover={{ scale: 1.1 }}
                              whileTap={{ scale: 0.9 }}
                              className="absolute top-2 right-2 w-7 h-7 bg-red-500 text-white rounded-full grid place-items-center opacity-0 group-hover:opacity-100 transition"
                            >
                              <X className="w-4 h-4" />
                            </motion.button>
                            {i === 0 && (
                              <span className="absolute bottom-2 left-2 badge bg-white text-slate-900">Cover</span>
                            )}
                          </motion.div>
                        ))}
                      </div>
                    )}
                  </TiltCard>
                </ScrollReveal>
              </motion.div>
            )}

            {/* STEP 1: DETAILS */}
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.3 }}
                className="space-y-6"
              >
                <ScrollReveal direction="up">
                  <TiltCard maxTilt={4} className="card p-6 space-y-6">
                    <div>
                      <label className="text-sm font-medium mb-1 block">Title *</label>
                      <input
                        type="text"
                        value={form.title}
                        onChange={(e) => setForm({ ...form, title: e.target.value })}
                        placeholder="e.g. MacBook Pro 16 inch M2 - Like New"
                        className="input"
                      />
                    </div>

                    <div>
                      <label className="text-sm font-medium mb-1 block">Description *</label>
                      <textarea
                        value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                        rows={5}
                        placeholder="Describe the item in detail..."
                        className="input"
                      />
                    </div>

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium mb-1 block">
                          Category *
                          {categoryAutoFilled && (
                            <span className="ml-2 text-xs text-brand-500 font-normal">AI detected</span>
                          )}
                        </label>
                        <select
                          value={form.category}
                          onChange={(e) => { setForm({ ...form, category: e.target.value }); setCategoryAutoFilled(false); }}
                          className="input"
                        >
                          <option value="">Select a category</option>
                          {categories.map((c) => (
                            <option key={c._id} value={c._id}>{c.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-1 block">Condition</label>
                        <select
                          value={form.condition}
                          onChange={(e) => setForm({ ...form, condition: e.target.value })}
                          className="input"
                        >
                          <option value="new">New</option>
                          <option value="like-new">Like New</option>
                          <option value="good">Good</option>
                          <option value="fair">Fair</option>
                          <option value="poor">Poor</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium mb-1 block">Brand</label>
                        <input
                          type="text"
                          value={form.brand}
                          onChange={(e) => setForm({ ...form, brand: e.target.value })}
                          placeholder="e.g. Apple"
                          className="input"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-1 block">Model</label>
                        <input
                          type="text"
                          value={form.model}
                          onChange={(e) => setForm({ ...form, model: e.target.value })}
                          placeholder="e.g. MacBook Pro 16"
                          className="input"
                        />
                      </div>
                    </div>

                    {/* Currency + Price Row */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium">Pricing</label>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500">Currency</span>
                          <div className="relative">
                            <select
                              value={selectedCurrency}
                              onChange={(e) => handleCurrencyChange(e.target.value)}
                              className="input py-1.5 pr-8 pl-3 text-sm font-medium min-w-[110px]"
                            >
                              {SUPPORTED_CURRENCIES.filter(c => ['INR','USD','EUR','GBP','AED','SGD','AUD','CAD','JPY'].includes(c.code)).map((c) => (
                                <option key={c.code} value={c.code}>{c.code} {c.symbol}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                      <div className="grid sm:grid-cols-3 gap-4">
                        <div>
                          <label className="text-sm font-medium mb-1 block">Price * ({currencyMeta.symbol})</label>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={form.price}
                            onChange={(e) => setForm({ ...form, price: e.target.value })}
                            placeholder="0"
                            className="input"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium mb-1 block">Original Price ({currencyMeta.symbol})</label>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={form.originalPrice}
                            onChange={(e) => setForm({ ...form, originalPrice: e.target.value })}
                            placeholder="0"
                            className="input"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium mb-1 block">Years Used</label>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={form.yearsUsed}
                            onChange={(e) => setForm({ ...form, yearsUsed: e.target.value })}
                            placeholder="0"
                            className="input"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-slate-400 mt-2">Stored as INR. Price guidance will convert automatically.</p>

                      {priceSuggestion && priceSuggestion.suggestedPrice > 0 && (
                        <div className="mt-3 p-3.5 rounded-xl bg-brand-50/50 dark:bg-brand-500/10 border border-brand-200/60 dark:border-brand-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>AI Fair Price Recommendation</span>
                            </div>
                            <div className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                              {getDisplayPrice(priceSuggestion.suggestedPrice)}{' '}
                              <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                                (Range: {getDisplayPrice(priceSuggestion.priceRange?.min || priceSuggestion.priceRange?.p25)} – {getDisplayPrice(priceSuggestion.priceRange?.max || priceSuggestion.priceRange?.p75)})
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={applySuggestedPrice}
                            className="px-3.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold shadow-sm transition-all self-start sm:self-center"
                          >
                            Use suggested price
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Product identity (only for supported categories) */}
                    {(identifierRequired || form.identifier?.trim()) && (
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-sm font-medium flex items-center gap-1">
                            <Shield className="w-4 h-4 text-brand-500" />
                            {form.identifierType === 'imei'
                              ? 'IMEI'
                              : form.identifierType === 'vin'
                              ? 'VIN (vehicle identification number)'
                              : 'Serial number'}{' '}
                            {identifierRequired ? '*' : '(optional)'}
                          </label>
                          <span className="text-xs text-slate-400">Hashed securely — never shown publicly</span>
                        </div>
                        <div className="grid sm:grid-cols-2 gap-3">
                          <select
                            value={form.identifierType}
                            onChange={(e) => setForm({ ...form, identifierType: e.target.value })}
                            className="input"
                          >
                            <option value="serial">Serial Number</option>
                            <option value="imei">IMEI (phones)</option>
                            <option value="vin">VIN (vehicles)</option>
                          </select>
                          <input
                            type="text"
                            value={form.identifier}
                            onChange={(e) => setForm({ ...form, identifier: e.target.value })}
                            placeholder={
                              form.identifierType === 'imei'
                                ? 'e.g. 356938035643809 (15 digits)'
                                : form.identifierType === 'vin'
                                ? 'e.g. 1HGBH41JXMN109186 (17 characters)'
                                : 'e.g. SN-88291-A (min 4 characters)'
                            }
                            className="input"
                          />
                        </div>
                        {identityStatus && (
                          <p className={cn('text-xs mt-2', identityStatus.warnings?.length ? 'text-amber-600' : 'text-emerald-600')}>
                            {identityStatus.warnings?.length
                              ? `Identity status: ${identityStatus.status.replace('_', ' ')} — ${identityStatus.warnings[0]}`
                              : `Possession: ${(identityStatus.verification?.possessionStatus || 'unverified').replace('_', ' ')}. Upload a proof photo with the code on the product page to verify.`}
                          </p>
                        )}
                        <p className="text-xs text-slate-400 mt-1">
                          Used to verify physical ownership and prevent resale of stolen goods.
                          Spaces and dashes are ignored, and only a SHA-256 hash is stored — the
                          raw value is never saved, logged, or shown to other users.
                        </p>
                      </div>
                    )}

                    {/* Identifier-free alternative (SCRUM-25): possession
                        verification is an optional extra — sellers without an
                        identifier can always continue normally, and a missing
                        identifier is never treated as fraud. */}
                    {!identifierRequired && !form.identifier?.trim() && (
                      <p className="text-xs text-slate-400 mt-2 flex items-start gap-1.5">
                        <Shield className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
                        <span>
                          Don't have a product identifier? No problem — you can list normally
                          without one. Optionally verify possession of the physical product from
                          your listing page after publishing.
                        </span>
                      </p>
                    )}

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium">Location</label>
                        <LocationDetectButton onDetect={handleLocationDetect} loading={locationDetector.loading} error={locationDetector.error} />
                      </div>
                      <div className="grid sm:grid-cols-3 gap-3">
                        <input
                          type="text"
                          value={form.location.city}
                          onChange={(e) => setForm({ ...form, location: { ...form.location, city: e.target.value } })}
                          placeholder="City"
                          className="input"
                        />
                        <input
                          type="text"
                          value={form.location.state}
                          onChange={(e) => setForm({ ...form, location: { ...form.location, state: e.target.value } })}
                          placeholder="State"
                          className="input"
                        />
                        <input
                          type="text"
                          value={form.location.country}
                          onChange={(e) => setForm({ ...form, location: { ...form.location, country: e.target.value } })}
                          placeholder="Country"
                          className="input"
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium">Specifications</label>
                        <button type="button" onClick={addSpec} className="text-sm text-brand-600 hover:underline">
                          + Add spec
                        </button>
                      </div>
                      {form.specifications.map((spec, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.03 }}
                          className="flex gap-2 mb-2"
                        >
                          <input
                            type="text"
                            value={spec.key}
                            onChange={(e) => updateSpec(i, e.target.value, spec.value)}
                            placeholder="Key"
                            className="input flex-1"
                          />
                          <input
                            type="text"
                            value={spec.value}
                            onChange={(e) => updateSpec(i, spec.key, e.target.value)}
                            placeholder="Value"
                            className="input flex-1"
                          />
                          <motion.button
                            type="button"
                            onClick={() => removeSpec(i)}
                            whileTap={{ scale: 0.9 }}
                            className="btn-secondary px-3"
                          >
                            <X className="w-4 h-4" />
                          </motion.button>
                        </motion.div>
                      ))}
                    </div>
                  </TiltCard>
                </ScrollReveal>
              </motion.div>
            )}

            {/* STEP 2: AI Analysis */}
            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.3 }}
                className="space-y-6"
              >
                <ScrollReveal direction="up">
                  <TiltCard maxTilt={4} className="card p-6 bg-gradient-to-br from-brand-50 to-accent-50 border-brand-100">
                    <div className="flex items-center gap-3 mb-6">
                      <motion.div
                        animate={{ rotate: [0, 5, -5, 0] }}
                        transition={{ duration: 3, repeat: Infinity }}
                        className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-600 to-accent-500 grid place-items-center"
                      >
                        <Sparkles className="w-6 h-6 text-white" />
                      </motion.div>
                      <div>
                        <h3 className="font-display font-bold text-lg">AI Analysis</h3>
                        <p className="text-sm text-slate-600">Powered by computer vision and pricing models</p>
                      </div>
                    </div>

                    <RevealOnScroll delay={0.05} className="grid sm:grid-cols-2 gap-4">
                      <AICard
                        icon={Camera}
                        title="Condition Score"
                        value={
                          aiAnalysis?.conditionScore != null
                            ? `${aiAnalysis.conditionScore}/100`
                            : 'Insufficient evidence'
                        }
                        color="from-emerald-500 to-teal-500"
                      />
                      <AICard
                        icon={Shield}
                        title="Damage"
                        value={
                          aiAnalysis?.damageScore != null
                            ? aiAnalysis.damageScore >= 50
                              ? 'High'
                              : aiAnalysis.damageScore >= 25
                              ? 'Moderate'
                              : 'Low'
                            : 'Insufficient evidence'
                        }
                        subtitle={
                          aiAnalysis?.damageScore != null
                            ? `${aiAnalysis.damageScore}/100 · higher means more damage`
                            : undefined
                        }
                        color="from-amber-500 to-red-500"
                      />
                      <AICard
                        icon={Tag}
                        title="Suggested Category"
                        value={aiAnalysis?.predictedCategory || '—'}
                        color="from-violet-500 to-purple-500"
                      />
                      <AICard
                        icon={TrendingUp}
                        title="Classification Confidence"
                        value={`${Math.round((aiAnalysis?.classificationConfidence || 0) * 100)}%`}
                        color="from-blue-500 to-cyan-500"
                      />
                    </RevealOnScroll>

                    {priceSuggestion && priceSuggestion.suggestedPrice > 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-6 p-4 rounded-xl bg-white border border-slate-200"
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <DollarSign className="w-5 h-5 text-emerald-500" />
                          <span className="font-semibold text-sm">Suggested Price</span>
                          <span className="text-xs text-slate-400">({selectedCurrency})</span>
                        </div>
                        <div className="text-2xl font-display font-extrabold gradient-text mb-1">
                          {getDisplayPrice(priceSuggestion.suggestedPrice)}
                        </div>
                        <div className="text-xs text-slate-500 mb-2">
                          Range: {getDisplayPrice(priceSuggestion.priceRange.min)} – {getDisplayPrice(priceSuggestion.priceRange.max)}
                        </div>
                        <div className="text-xs text-slate-500">
                          Suggested based on {priceSuggestion.comparableCount} comparable listing{priceSuggestion.comparableCount !== 1 ? 's' : ''}
                          {priceSuggestion.confidence > 0 && ` · ${Math.round(priceSuggestion.confidence * 100)}% confidence`}
                        </div>
                        {priceSuggestion.factors?.length > 0 && (
                          <div className="mt-2 text-xs text-slate-400">
                            {priceSuggestion.factors.slice(0, 2).map((f, i) => (
                              <div key={i}>· {f}</div>
                            ))}
                          </div>
                        )}
                        <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                          <button
                            type="button"
                            onClick={applySuggestedPrice}
                            className="px-4 py-2 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white text-xs font-semibold shadow-sm hover:shadow transition-all"
                          >
                            Use suggested price
                          </button>
                        </div>
                      </motion.div>
                    )}
                    {priceSuggestion && priceSuggestion.suggestedPrice === 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-6 p-4 rounded-xl bg-white border border-slate-200 text-sm text-slate-500"
                      >
                        Not enough data for a price suggestion yet. Add more details (category, original price) to get a recommendation.
                      </motion.div>
                    )}

                    <motion.p
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-6 text-sm text-slate-600"
                    >
                      💡 Our AI analyzed your images using a MobileNet image classification model and detected visual signals.
                    </motion.p>
                  </TiltCard>
                </ScrollReveal>
              </motion.div>
            )}

            {/* STEP 3: REVIEW */}
            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.3 }}
                className="space-y-6"
              >
                <ScrollReveal direction="up">
                  <TiltCard maxTilt={4} className="card p-6">
                    <h3 className="font-display font-bold text-lg mb-6">Review your listing</h3>
                    <div className="grid sm:grid-cols-2 gap-6">
                      <div>
                        <motion.img
                          src={images[0]?.url}
                          alt=""
                          className="w-full aspect-square object-cover rounded-xl"
                          initial={{ scale: 1.05 }}
                          animate={{ scale: 1 }}
                          transition={{ duration: 0.8 }}
                        />
                      </div>
                      <div className="space-y-4">
                        <motion.h2
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="font-display font-bold text-xl"
                        >
                          {form.title}
                        </motion.h2>
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.1 }}
                          className="text-3xl font-display font-extrabold gradient-text"
                        >
                          {(() => {
                            const n = toNumber(form.price);
                            if (Number.isNaN(n)) return '—';
                            const inr = rates ? convertPrice(n, selectedCurrency, 'INR', rates) : n;
                            return formatPrice(inr, 'INR');
                          })()}
                          <span className="text-sm font-normal text-slate-500 ml-2">({getDisplayPrice(toNumber(form.price) && rates ? convertPrice(toNumber(form.price), selectedCurrency, 'INR', rates) : 0)} in {selectedCurrency})</span>
                        </motion.div>
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.2 }}
                          className="flex gap-2"
                        >
                          <span className="badge bg-slate-100">{getConditionLabel(form.condition)}</span>
                          {form.brand && <span className="badge bg-slate-100">{form.brand}</span>}
                        </motion.div>
                        <motion.p
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.3 }}
                          className="text-sm text-slate-600 line-clamp-4"
                        >
                          {form.description}
                        </motion.p>
                        {(form.location.city || form.location.country) && (
                          <p className="text-xs text-slate-500">{[form.location.city, form.location.state, form.location.country].filter(Boolean).join(', ')}</p>
                        )}
                        {identityStatus && (
                          <div className={cn('text-xs p-2 rounded-lg', identityStatus.warnings?.length ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700')}>
                            <span className="font-medium">Identity verification:</span>{' '}
                            {identityStatus.warnings?.length
                              ? `${identityStatus.status.replace('_', ' ')} — review required`
                              : 'verified ownership registered'}
                          </div>
                        )}
                      </div>
                    </div>
                  </TiltCard>
                </ScrollReveal>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Navigation */}
          <ScrollReveal delay={0.3} direction="up">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex justify-between mt-10"
            >
              <MagneticButton
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0}
                className="btn-secondary"
                strength={0.15}
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </MagneticButton>

              {step < STEPS.length - 1 ? (
                <MagneticButton
                  onClick={() => setStep((s) => s + 1)}
                  disabled={!canProceed()}
                  className="btn-primary"
                  strength={0.15}
                >
                  Next
                  <ArrowRight className="w-4 h-4" />
                </MagneticButton>
              ) : (
                <MagneticButton
                  onClick={handleSubmit}
                  disabled={loading || uploading}
                  className="btn-primary"
                  strength={0.15}
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Creating listing...
                    </>
                  ) : uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Publish Listing
                    </>
                  )}
                </MagneticButton>
              )}
            </motion.div>
          </ScrollReveal>
        </div>
      </div>
    </PageTransition>
  );
}

function AICard({ icon: Icon, title, value, color, subtitle }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      className="p-4 rounded-xl bg-white border border-slate-200"
    >
      <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${color} grid place-items-center mb-3`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
      <p className="text-xs text-slate-500 mb-1">{title}</p>
      <p className="font-display font-bold text-xl">{value}</p>
      {subtitle && <p className="text-[10px] text-slate-400 mt-1">{subtitle}</p>}
    </motion.div>
  );
}
