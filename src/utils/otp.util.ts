export const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const OTP_EXPIRY_MINUTES = 10;
