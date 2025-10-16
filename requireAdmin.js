function requireAdmin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: "Admins only" });
  next();
}
module.exports = { requireAdmin };
