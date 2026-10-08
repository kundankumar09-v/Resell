import { motion } from 'framer-motion';
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PRODUCT_FALLBACK_IMAGE, handleImageError } from '../../utils/imageFallback';

export default function ImageGallery({ images = [] }) {
  const [active, setActive] = useState(0);
  const normalizedImages = Array.isArray(images) && images.length > 0
    ? images.map((img) => (typeof img === 'string' ? { url: img } : img))
    : [{ url: PRODUCT_FALLBACK_IMAGE }];

  const currentImage = normalizedImages[active]?.url || PRODUCT_FALLBACK_IMAGE;

  const next = () => setActive((p) => (p + 1) % normalizedImages.length);
  const prev = () => setActive((p) => (p - 1 + normalizedImages.length) % normalizedImages.length);

  return (
    <div className="space-y-3">
      <div className="relative aspect-square overflow-hidden rounded-2xl bg-slate-100 group">
        <motion.img
          key={currentImage}
          initial={{ opacity: 0, scale: 1.05 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          src={currentImage}
          alt="Product"
          className="w-full h-full object-cover"
          onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
        />

        {normalizedImages.length > 1 && (
          <>
            <button
              onClick={prev}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/90 backdrop-blur grid place-items-center opacity-0 group-hover:opacity-100 transition hover:bg-white shadow-lg"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={next}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/90 backdrop-blur grid place-items-center opacity-0 group-hover:opacity-100 transition hover:bg-white shadow-lg"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}
      </div>

      {normalizedImages.length > 1 && (
        <div className="grid grid-cols-5 gap-2">
          {normalizedImages.map((img, i) => (
            <button
              key={img.url || i}
              onClick={() => setActive(i)}
              className={`relative aspect-square overflow-hidden rounded-lg border-2 transition ${
                i === active ? 'border-brand-500' : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              <img
                src={img.url || PRODUCT_FALLBACK_IMAGE}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => handleImageError(e, PRODUCT_FALLBACK_IMAGE)}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
