module.exports = async (req, res) => {
  if (req.method === 'POST') return res.status(200).json({ ok: true });
};
