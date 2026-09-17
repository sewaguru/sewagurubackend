export const createBookingDisplayId = () => {
  const value = Math.floor(10000 + Math.random() * 90000);
  return `SW${value}`;
};

