import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { lazy, Suspense } from 'react';
import { useAuth } from './contexts/AuthContext';
import Navbar from './components/layout/Navbar';
import Footer from './components/layout/Footer';
import Loader from './components/ui/Loader';
import AntigravityBackground from './components/ui/AntigravityBackground';
import CustomCursor from './components/ui/CustomCursor';

const Home = lazy(() => import('./pages/Home'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const Marketplace = lazy(() => import('./pages/Marketplace'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const SellProduct = lazy(() => import('./pages/SellProduct'));
const EditProduct = lazy(() => import('./pages/EditProduct'));
const Favorites = lazy(() => import('./pages/Favorites'));
const Offers = lazy(() => import('./pages/Offers'));
const Checkout = lazy(() => import('./pages/Checkout'));
const OrderSuccess = lazy(() => import('./pages/OrderSuccess'));
const OrderCancelled = lazy(() => import('./pages/OrderCancelled'));
const Orders = lazy(() => import('./pages/Orders'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const MyProducts = lazy(() => import('./pages/MyProducts'));
const Profile = lazy(() => import('./pages/Profile'));
const SellerProfile = lazy(() => import('./pages/SellerProfile'));
const Chat = lazy(() => import('./pages/Chat'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const AdminUsers = lazy(() => import('./pages/AdminUsers'));
const AdminProducts = lazy(() => import('./pages/AdminProducts'));
const AdminAppeals = lazy(() => import('./pages/AdminAppeals'));
const AdminReports = lazy(() => import('./pages/AdminReports'));
const AdminAnalytics = lazy(() => import('./pages/AdminAnalytics'));
const AdminCategories = lazy(() => import('./pages/AdminCategories'));
const NotFound = lazy(() => import('./pages/NotFound'));

const ProtectedRoute = ({ children, roles }) => {
  const { user, loading } = useAuth();
  if (loading) return <Loader />;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
};

function App() {
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');
  const isHome = location.pathname === '/';

  if (isAdminRoute) {
    return (
      <div className="relative min-h-screen">
        <AntigravityBackground className="fixed inset-0 -z-10" density={0.5} interactive={false} />
        <CustomCursor />
        <Suspense fallback={<Loader />}>
        <Routes location={location} key={location.pathname}>
          <Route
            path="/admin/dashboard"
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/users"
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminUsers />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/products"
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminProducts />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/appeals"
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminAppeals />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/reports"
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminReports />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/analytics"
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminAnalytics />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/categories"
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminCategories />
              </ProtectedRoute>
            }
          />
        </Routes>
      </Suspense>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen flex flex-col">
      <AntigravityBackground className="fixed inset-0 -z-10" />
      <CustomCursor />
      <Navbar />
      <main className="flex-1">
        {!isHome && <div aria-hidden="true" className="h-20" />}
        <Suspense fallback={<Loader />}>
          <AnimatePresence mode="wait">
            <Routes location={location} key={location.pathname}>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/marketplace" element={<Marketplace />} />
              <Route path="/product/:id" element={<ProductDetail />} />
              <Route path="/seller/:id" element={<SellerProfile />} />
              <Route
                path="/sell"
                element={
                  <ProtectedRoute roles={['seller', 'admin']}>
                    <SellProduct />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/edit/:id"
                element={
                  <ProtectedRoute roles={['seller', 'admin']}>
                    <EditProduct />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/favorites"
                element={
                  <ProtectedRoute>
                    <Favorites />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/offers"
                element={
                  <ProtectedRoute>
                    <Offers />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/checkout/:id"
                element={
                  <ProtectedRoute>
                    <Checkout />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/order-success"
                element={
                  <ProtectedRoute>
                    <OrderSuccess />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/order-cancelled"
                element={
                  <ProtectedRoute>
                    <OrderCancelled />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/orders"
                element={
                  <ProtectedRoute>
                    <Orders />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/orders/:id"
                element={
                  <ProtectedRoute>
                    <OrderDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/my-products"
                element={
                  <ProtectedRoute roles={['seller', 'admin']}>
                    <MyProducts />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/profile"
                element={
                  <ProtectedRoute>
                    <Profile />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/chat"
                element={
                  <ProtectedRoute>
                    <Chat />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/chat/:id"
                element={
                  <ProtectedRoute>
                    <Chat />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AnimatePresence>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}

export default App;
