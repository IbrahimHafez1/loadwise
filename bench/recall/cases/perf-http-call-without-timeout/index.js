// Outbound fetch with no timeout or abort signal: a stalled upstream pins the request forever.
module.exports = async function loadRates() {
  const response = await fetch('https://rates.example.com/latest');
  return response.json();
};
