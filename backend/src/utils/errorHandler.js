const AppError = require('./AppError');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  error.statusCode = err.statusCode || 500;
  error.code = err.code || 'INTERNAL_ERROR';

  if (err.name === 'CastError') {
    error = new AppError(`Invalid ${err.path}: ${err.value}`, 400, 'INVALID_ID');
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    error = new AppError(`Duplicate ${field} entered`, 400, 'DUPLICATE');
  }

  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    error = new AppError(messages.join(', '), 400, 'VALIDATION_ERROR');
  }

  // Logging: expected operational 4xx errors (e.g. anonymous 401 auth checks)
  // get a concise one-line log — no noisy stack trace. Unexpected errors and
  // 5xx failures still get the full error with stack for diagnosis.
  if (process.env.NODE_ENV === 'development') {
    if (error.isOperational && error.statusCode < 500) {
      console.log(
        `[${error.statusCode}] ${error.code}: ${error.message} — ${req.method} ${req.originalUrl}`
      );
    } else {
      console.error('[Error]', error);
    }
  } else if (error.statusCode >= 500) {
    // Production: log real server failures (server-side console only —
    // never leaked to the client response) so 5xx are diagnosable.
    console.error(
      `[Error] ${error.statusCode} ${error.code}: ${error.message} — ${req.method} ${req.originalUrl}`
    );
  }

  res.status(error.statusCode).json({
    success: false,
    code: error.code,
    message: error.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

const notFound = (req, res, next) => {
  next(new AppError(`Route not found: ${req.originalUrl}`, 404, 'NOT_FOUND'));
};

module.exports = { errorHandler, notFound };
